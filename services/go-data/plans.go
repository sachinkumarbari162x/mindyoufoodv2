// The nutrition care plan — what she asked the client to do
//
//	GET    /crm/plans?personId=      every version, newest first
//	GET    /crm/plan?id=             one version
//	POST   /crm/plans                open the draft, or start the next plan
//	PATCH  /crm/plans/{id}           save a draft
//	POST   /crm/plans/{id}/issue     hand it over — freezes it
//	POST   /crm/plans/{id}/amend     write the next version
//
// SAME RULES AS THE ASSESSMENT, and deliberately the same shape of
// code, because a second pattern for "versioned clinical record"
// would be a second set of edge cases to get right. If you have read
// assessments.go you have read this.
//
// WHAT IS DIFFERENT: a plan leaves the building. The client is given
// it, prints it, acts on it for a month. So `issued` rather than
// `final`, and the refusal to edit an issued plan is stricter in
// spirit than the assessment's — an assessment nobody has seen can
// be corrected without consequence, whereas a plan somebody is
// following cannot.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// "Aisha Khan" + plan 1 + amendment 0 -> "aishakhanp1_0"
//
// The `p` is what stops a plan reference being mistaken for an
// assessment reference down a phone — "aishakhan1_0" and
// "aishakhanp1_0" are different documents about the same visit.
func makePlanRef(name string, planNo, amendment int) string {
	slug := refCleaner.ReplaceAllString(strings.ToLower(name), "")
	if len(slug) > 18 {
		slug = slug[:18]
	}
	if slug == "" {
		slug = "client"
	}
	return fmt.Sprintf("%sp%d_%d", slug, planNo, amendment)
}

type plan struct {
	ID             string          `json:"id"`
	PersonID       string          `json:"personId"`
	PersonName     string          `json:"personName"`
	PersonEmail    string          `json:"personEmail"`
	ConsultationID *string         `json:"consultationId"`
	PlanNo         int             `json:"planNo"`
	Amendment      int             `json:"amendment"`
	Ref            string          `json:"ref"`
	Amends         *string         `json:"amends"`
	AmendsRef      *string         `json:"amendsRef"`
	Status         string          `json:"status"`
	Body           string          `json:"body"`
	PrivateNote    string          `json:"privateNote"`
	Targets        json.RawMessage `json:"targets"`
	RecordedBy     string          `json:"recordedBy"`
	StartedAt      string          `json:"startedAt"`
	UpdatedAt      string          `json:"updatedAt"`
	IssuedAt       *string         `json:"issuedAt"`

	// Times the assistant has read this version. Capped at three —
	// see migration 0026 and the refusal in the BFF.
	Reads          int             `json:"reads"`

	// Times a first draft has been written from the finalised
	// assessment. Its own budget, not a share of Reads — see
	// migration 0029 for why the two must not be pooled.
	Drafts         int             `json:"drafts"`
}

const planCols = `
	pl.id, pl.person_id, p.name, p.email, pl.consultation_id,
	pl.plan_no, pl.amendment, pl.ref, pl.amends,
	(SELECT prev.ref FROM crm.plans prev WHERE prev.id = pl.amends),
	pl.status, pl.body, pl.private_note, pl.targets,
	pl.recorded_by, pl.started_at, pl.updated_at, pl.issued_at, pl.reads, pl.drafts`

func scanPlan(row pgx.Row) (plan, error) {
	var pl plan
	var started, updated time.Time
	var issued *time.Time
	err := row.Scan(&pl.ID, &pl.PersonID, &pl.PersonName, &pl.PersonEmail, &pl.ConsultationID,
		&pl.PlanNo, &pl.Amendment, &pl.Ref, &pl.Amends, &pl.AmendsRef,
		&pl.Status, &pl.Body, &pl.PrivateNote, &pl.Targets,
		&pl.RecordedBy, &started, &updated, &issued, &pl.Reads, &pl.Drafts)
	if err != nil {
		return pl, err
	}
	pl.StartedAt = started.Format(time.RFC3339)
	pl.UpdatedAt = updated.Format(time.RFC3339)
	pl.IssuedAt = ts(issued)
	return pl, nil
}

// GET /crm/plans?personId=
func crmPlanList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		personID := r.URL.Query().Get("personId")
		if personID == "" {
			bad(w, 400, "invalid", "a person is needed")
			return
		}

		rows, err := st.pool.Query(r.Context(), `
			SELECT `+planCols+`
			  FROM crm.plans pl
			  JOIN crm.people p ON p.id = pl.person_id
			 WHERE pl.person_id = $1
			 ORDER BY pl.plan_no DESC, pl.amendment DESC`, personID)
		if err != nil {
			bad(w, 500, "read_failed", "could not read those")
			return
		}
		defer rows.Close()

		out := []plan{}
		for rows.Next() {
			pl, err := scanPlan(rows)
			if err != nil {
				continue
			}
			out = append(out, pl)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "plans": out})
	}
}

// GET /crm/plan?id=
func crmPlanOne(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		pl, err := scanPlan(st.pool.QueryRow(r.Context(), `
			SELECT `+planCols+` FROM crm.plans pl
			  JOIN crm.people p ON p.id = pl.person_id
			 WHERE pl.id = $1`, r.URL.Query().Get("id")))
		if err != nil {
			bad(w, 404, "not_found", "no plan with that reference")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "plan": pl})
	}
}

/* POST /crm/plans — open the draft, or start the next plan.

   IDEMPOTENT, exactly like the assessment's. Opening the pad twice
   must not produce two half-written plans for one person, and the
   partial unique index is what makes that hold when she taps twice
   before the first request has answered. */
func crmPlanOpen(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			PersonID       string          `json:"personId"`
			ConsultationID *string         `json:"consultationId"`
			Targets        json.RawMessage `json:"targets"`
			By             string          `json:"by"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.PersonID == "" {
			bad(w, 400, "invalid", "a person is needed")
			return
		}
		if in.By == "" {
			in.By = "unknown"
		}
		if len(in.Targets) == 0 {
			in.Targets = json.RawMessage("{}")
		}

		ctx := r.Context()

		// An open draft is the answer, if there is one.
		if pl, err := scanPlan(st.pool.QueryRow(ctx, `
			SELECT `+planCols+`
			  FROM crm.plans pl
			  JOIN crm.people p ON p.id = pl.person_id
			 WHERE pl.person_id = $1 AND pl.status = 'draft'
			 ORDER BY pl.plan_no DESC LIMIT 1`, in.PersonID)); err == nil {
			writeJSON(w, 200, map[string]any{"ok": true, "plan": pl, "opened": "existing"})
			return
		}

		var name string
		if err := st.pool.QueryRow(ctx,
			`SELECT name FROM crm.people WHERE id = $1`, in.PersonID).Scan(&name); err != nil {
			bad(w, 404, "not_found", "no person with that reference")
			return
		}

		// The next plan number — amendments do not count as plans.
		var planNo int
		_ = st.pool.QueryRow(ctx,
			`SELECT COALESCE(MAX(plan_no) + 1, 0) FROM crm.plans WHERE person_id = $1`,
			in.PersonID).Scan(&planNo)

		id := ""
		err := st.pool.QueryRow(ctx, `
			INSERT INTO crm.plans
			  (person_id, consultation_id, plan_no, amendment, ref, status, targets, recorded_by)
			VALUES ($1, $2, $3, 0, $4, 'draft', $5, $6)
			RETURNING id`,
			in.PersonID, in.ConsultationID, planNo,
			makePlanRef(name, planNo, 0), in.Targets, in.By).Scan(&id)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				bad(w, 409, "already_open", "a draft plan is already open")
				return
			}
			bad(w, 500, "not_opened", "could not open a plan")
			return
		}

		pl, _ := scanPlan(st.pool.QueryRow(ctx, `
			SELECT `+planCols+` FROM crm.plans pl
			  JOIN crm.people p ON p.id = pl.person_id WHERE pl.id = $1`, id))
		writeJSON(w, 201, map[string]any{"ok": true, "plan": pl, "opened": "new"})
	}
}

/* PATCH /crm/plans/{id} — saving, and only ever a draft.

   The WHERE clause carries `status = 'draft'`, so an issued plan
   cannot be edited even by a request that asks nicely. That is the
   rule the whole table exists for and it belongs in the statement
   rather than in an if — a check in Go is a check somebody can
   route around by adding a second caller. */
func crmPlanSave(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Body        *string         `json:"body"`
			PrivateNote *string         `json:"privateNote"`
			Targets     json.RawMessage `json:"targets"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 512<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}

		id := r.PathValue("id")
		tag, err := st.pool.Exec(r.Context(), `
			UPDATE crm.plans SET
			  body         = COALESCE($2, body),
			  private_note = COALESCE($3, private_note),
			  targets      = COALESCE($4, targets),
			  updated_at   = now()
			 WHERE id = $1 AND status = 'draft'`,
			id, in.Body, in.PrivateNote, nullableJSON(in.Targets))
		if err != nil {
			bad(w, 500, "not_saved", "could not save that")
			return
		}
		if tag.RowsAffected() == 0 {
			/* Either it is gone or it has been issued. Said as one
			   message because the caller cannot act on the difference
			   — both mean "this is not yours to edit any more". */
			bad(w, 409, "not_editable", "that plan has been issued — amend it instead")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

/* POST /crm/plans/{id}/issue — hand it over.

   AN EMPTY PLAN CANNOT BE ISSUED. Everything else in this system
   lets her leave a field blank, because a half-filled assessment is
   still worth having. A blank plan is not: the client receives a
   sheet of paper with nothing on it, and the record says she gave
   them advice. */
func crmPlanIssue(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")

		var body, status string
		if err := st.pool.QueryRow(r.Context(),
			`SELECT body, status FROM crm.plans WHERE id = $1`, id).Scan(&body, &status); err != nil {
			bad(w, 404, "not_found", "no plan with that reference")
			return
		}
		if status != "draft" {
			bad(w, 409, "already_issued", "that plan has already been issued")
			return
		}
		if strings.TrimSpace(body) == "" {
			bad(w, 400, "empty", "there is nothing written in it yet")
			return
		}

		if _, err := st.pool.Exec(r.Context(), `
			UPDATE crm.plans
			   SET status = 'issued', issued_at = now(), updated_at = now()
			 WHERE id = $1 AND status = 'draft'`, id); err != nil {
			bad(w, 500, "not_issued", "could not issue that")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

/* POST /crm/plans/{id}/amend — the only way to change an issued plan.

   NOT A REOPEN. The issued version stays exactly as the client
   received it and this writes its successor, carrying the text
   forward so the new version is a complete plan rather than a diff
   nobody can read on its own. */
func crmPlanAmend(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			By string `json:"by"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in)
		if in.By == "" {
			in.By = "unknown"
		}

		id := r.PathValue("id")
		ctx := r.Context()

		tx, err := st.pool.Begin(ctx)
		if err != nil {
			bad(w, 500, "not_amended", "could not amend that")
			return
		}
		defer tx.Rollback(ctx)

		var personID, name, status string
		var planNo, amendment int
		if err := tx.QueryRow(ctx, `
			SELECT pl.person_id, p.name, pl.status, pl.plan_no, pl.amendment
			  FROM crm.plans pl JOIN crm.people p ON p.id = pl.person_id
			 WHERE pl.id = $1`, id).
			Scan(&personID, &name, &status, &planNo, &amendment); err != nil {
			bad(w, 404, "not_found", "no plan with that reference")
			return
		}
		if status != "issued" {
			bad(w, 409, "not_issued", "that version is still a draft — it can just be edited")
			return
		}

		next := ""
		err = tx.QueryRow(ctx, `
			INSERT INTO crm.plans
			  (person_id, consultation_id, plan_no, amendment, ref, amends,
			   status, body, private_note, targets, recorded_by)
			SELECT person_id, consultation_id, plan_no, $3, $4, id,
			       'draft', body, private_note, targets, $5
			  FROM crm.plans WHERE id = $1 AND person_id = $2
			RETURNING id`,
			id, personID, amendment+1, makePlanRef(name, planNo, amendment+1), in.By).Scan(&next)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				bad(w, 409, "already_amending", "an amendment of that version is already open")
				return
			}
			bad(w, 500, "not_amended", "could not amend that")
			return
		}

		/* THE ROWS SHE ALREADY AGREED WITH COME FORWARD TOO.
		   Without this, amending a plan leaves the new version with no
		   items — and once a programme is running against it, the
		   client's list of things to do would empty itself the moment
		   she corrected a sentence.

		   Only confirmed and edited rows travel. A proposal she never
		   ruled on belonged to the old text and should be read again
		   from the new; a rejection was wrong about the old text and
		   says nothing about this one.

		   Her verdict travels intact — she did confirm that row, and
		   re-asking her because a different sentence changed would
		   make amending something she avoids. */
		if _, err := tx.Exec(ctx, `
			INSERT INTO crm.plan_items
			  (plan_id, seq, source_line, kind, label, quantity, unit, schedule,
			   proposed, status, model, confirmed_by, confirmed_at)
			SELECT $2, seq, source_line, kind, label, quantity, unit, schedule,
			       proposed, status, model, confirmed_by, confirmed_at
			  FROM crm.plan_items
			 WHERE plan_id = $1 AND status IN ('confirmed', 'edited')
			 ORDER BY seq`, id, next); err != nil {
			bad(w, 500, "not_amended", "could not carry the rows forward")
			return
		}

		if err := tx.Commit(ctx); err != nil {
			bad(w, 500, "not_amended", "could not amend that")
			return
		}

		pl, _ := scanPlan(st.pool.QueryRow(ctx, `
			SELECT `+planCols+` FROM crm.plans pl
			  JOIN crm.people p ON p.id = pl.person_id WHERE pl.id = $1`, next))
		writeJSON(w, 201, map[string]any{"ok": true, "plan": pl})
	}
}

/* The plans attached to one consultation, for the room and for
   Today. Kept separate from the list-by-person query because the
   question is different: "what did she write after this session"
   rather than "what has this person ever been given". */
func (s *Store) plansForConsultation(ctx context.Context, consultationID string) []plan {
	rows, err := s.pool.Query(ctx, `
		SELECT `+planCols+`
		  FROM crm.plans pl
		  JOIN crm.people p ON p.id = pl.person_id
		 WHERE pl.consultation_id = $1
		 ORDER BY pl.plan_no DESC, pl.amendment DESC`, consultationID)
	if err != nil {
		return []plan{}
	}
	defer rows.Close()

	out := []plan{}
	for rows.Next() {
		if pl, err := scanPlan(rows); err == nil {
			out = append(out, pl)
		}
	}
	return out
}

/* POST /crm/plans/{id}/read — claim one of the three model reads.

   THE CAP BELONGS TO THE MODEL CALL, and this route exists because
   Go cannot see one. It used to be counted on the plan-items write,
   which was the wrong event twice over: the deterministic Build
   writes rows without a model and would have spent a read, and a
   model call that failed after answering would not have.
   
   ATOMIC, and that is the point of doing it in one statement. The
   old shape was SELECT the count, compare it in Go, then UPDATE —
   which two requests arriving together both pass. The WHERE clause
   carries the limit here, so the fourth claim finds no row to
   update and is refused by the database rather than by a race.
   
   Claimed AFTER the model has answered, by the BFF. A call that
   times out or comes back unreadable should not cost her one of
   three. */
func crmPlanReadClaim(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var reads int
		err := st.pool.QueryRow(r.Context(), `
			UPDATE crm.plans
			   SET reads = reads + 1
			 WHERE id = $1 AND status = 'draft' AND reads < $2
			RETURNING reads`, r.PathValue("id"), planReadCap).Scan(&reads)

		if err != nil {
			/* Either it is at the limit, or it has been issued, or it
			   is gone. One message: in every case the answer is that
			   the assistant is not reading this version again. */
			bad(w, 429, "read_limit",
				"the assistant has read this plan three times — edit the wording, or issue it and amend")
			return
		}
		writeJSON(w, 200, map[string]any{
			"ok": true, "reads": reads, "left": planReadCap - reads,
		})
	}
}

/* POST /crm/plans/{id}/draft — claim one of the three first drafts.

   THE SAME SHAPE AS THE READ CLAIM ABOVE, and deliberately a
   separate counter: see migration 0029. One press of Fetch and
   create must not cost her a third of the reads she needs
   afterwards to check her own edits.

   CLAIMED BEFORE THE MODEL IS CALLED, and that is the one place
   this differs from a read. A read is cheap and claiming it after
   the answer is the kinder order. Writing a draft sends the whole
   clinical record to somebody else's model and takes several
   seconds; claiming first is what makes a double-tap on a slow
   connection cost one draft rather than two.

   The cost of that order is that a draft which times out is still
   spent. That is the right way round: two identical requests in
   flight with a client's medical history in them is the failure
   worth preventing.

   DRAFTS ARE FOR DRAFTS. `status = 'draft'` in the WHERE clause,
   so an issued plan cannot have a new one written over it — that
   is what an amendment is for, and an amendment starts at zero. */
func crmPlanDraftClaim(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var drafts int
		err := st.pool.QueryRow(r.Context(), `
			UPDATE crm.plans
			   SET drafts = drafts + 1
			 WHERE id = $1 AND status = 'draft' AND drafts < $2
			RETURNING drafts`, r.PathValue("id"), planDraftCap).Scan(&drafts)

		if err != nil {
			bad(w, 429, "draft_limit",
				"the assistant has written three drafts from this assessment — "+
					"edit what it gave you, or fill in more of the assessment and amend")
			return
		}
		writeJSON(w, 200, map[string]any{
			"ok": true, "drafts": drafts, "left": planDraftCap - drafts,
		})
	}
}
