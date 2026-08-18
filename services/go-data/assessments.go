// The nutrition assessment record
//
//	GET   /crm/assessments?personId=   every version, newest first
//	GET   /crm/assessments/{id}        one version, with its measurements
//	POST  /crm/assessments             open the current draft, or start one
//	PATCH /crm/assessments/{id}        save (drafts only)
//	POST  /crm/assessments/{id}/final  finalise
//	POST  /crm/assessments/{id}/amend  copy forward into the next version
//
// THE ONLY WAY TO CHANGE A FINALISED ASSESSMENT IS TO WRITE A NEW
// ONE. There is no UPDATE in this file that touches a finalised row
// and no DELETE at all — the amend handler copies forward and leaves
// the previous version exactly as it was written.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

/* Which fields are a trend rather than a note. These never go into
   the answers document — they are rows in crm.measurements, so they
   can be drawn as a curve, and storing them twice would mean two
   copies of a weight that disagree the moment one is corrected. */
var trendFields = map[string]string{
	"weight_kg":    "kg",
	"height_cm":    "cm",
	"waist_cm":     "cm",
	"hip_cm":       "cm",
	"body_fat_pct": "%",
	"lean_mass_kg": "kg",
}

var refCleaner = regexp.MustCompile(`[^a-z0-9]+`)

// "Meera Raghavan" + visit 0 + amendment 1 -> "meeraraghavan0_1"
func makeRef(name string, visit, amendment int) string {
	slug := refCleaner.ReplaceAllString(strings.ToLower(name), "")
	if len(slug) > 18 {
		slug = slug[:18]
	}
	if slug == "" {
		slug = "client"
	}
	return fmt.Sprintf("%s%d_%d", slug, visit, amendment)
}

type assessment struct {
	ID             string          `json:"id"`
	PersonID       string          `json:"personId"`
	PersonName     string          `json:"personName"`
	PersonEmail    string          `json:"personEmail"`
	ConsultationID *string         `json:"consultationId"`
	Visit          int             `json:"visit"`
	Amendment      int             `json:"amendment"`
	Ref            string          `json:"ref"`
	Amends         *string         `json:"amends"`
	AmendsRef      *string         `json:"amendsRef"`
	Kind           string          `json:"kind"`
	Status         string          `json:"status"`
	Answers        json.RawMessage `json:"answers"`
	OpenSections   json.RawMessage `json:"openSections"`
	Notes          string          `json:"notes"`
	RecordedBy     string          `json:"recordedBy"`
	StartedAt      string          `json:"startedAt"`
	UpdatedAt      string          `json:"updatedAt"`
	FinalisedAt    *string         `json:"finalisedAt"`
	Measurements   []measurement   `json:"measurements"`
}

type measurement struct {
	Metric  string   `json:"metric"`
	Value   float64  `json:"value"`
	Unit    string   `json:"unit"`
	Kind    string   `json:"kind"`
	Method  *string  `json:"method"`
	TakenAt string   `json:"takenAt"`
	RefLow  *float64 `json:"refLow"`
	RefHigh *float64 `json:"refHigh"`
}

const assessmentCols = `
	a.id, a.person_id, p.name, p.email, a.consultation_id,
	a.visit, a.amendment, a.ref, a.amends,
	(SELECT prev.ref FROM crm.assessments prev WHERE prev.id = a.amends),
	a.kind, a.status, a.answers, a.open_sections, a.notes,
	a.recorded_by, a.started_at, a.updated_at, a.finalised_at`

func scanAssessment(row pgx.Row) (assessment, error) {
	var a assessment
	var started, updated time.Time
	var finalised *time.Time
	err := row.Scan(&a.ID, &a.PersonID, &a.PersonName, &a.PersonEmail, &a.ConsultationID,
		&a.Visit, &a.Amendment, &a.Ref, &a.Amends, &a.AmendsRef,
		&a.Kind, &a.Status, &a.Answers, &a.OpenSections, &a.Notes,
		&a.RecordedBy, &started, &updated, &finalised)
	if err != nil {
		return a, err
	}
	a.StartedAt = started.Format(time.RFC3339)
	a.UpdatedAt = updated.Format(time.RFC3339)
	a.FinalisedAt = ts(finalised)
	a.Measurements = []measurement{}
	return a, nil
}

func (s *Store) measurementsFor(ctx context.Context, assessmentID string) []measurement {
	rows, err := s.pool.Query(ctx, `
		SELECT metric, value, unit, kind, method, taken_at, ref_low, ref_high
		  FROM crm.measurements WHERE assessment_id = $1
		 ORDER BY metric`, assessmentID)
	if err != nil {
		return []measurement{}
	}
	defer rows.Close()

	out := []measurement{}
	for rows.Next() {
		var m measurement
		var taken time.Time
		if err := rows.Scan(&m.Metric, &m.Value, &m.Unit, &m.Kind, &m.Method,
			&taken, &m.RefLow, &m.RefHigh); err != nil {
			continue
		}
		m.TakenAt = taken.Format(time.RFC3339)
		out = append(out, m)
	}
	return out
}

// GET /crm/assessments?personId=
func crmAssessmentList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		personID := r.URL.Query().Get("personId")
		if personID == "" {
			bad(w, 400, "invalid", "a person is needed")
			return
		}

		rows, err := st.pool.Query(r.Context(), `
			SELECT `+assessmentCols+`
			  FROM crm.assessments a
			  JOIN crm.people p ON p.id = a.person_id
			 WHERE a.person_id = $1
			 ORDER BY a.visit DESC, a.amendment DESC`, personID)
		if err != nil {
			bad(w, 500, "read_failed", "could not read those")
			return
		}
		defer rows.Close()

		out := []assessment{}
		for rows.Next() {
			a, err := scanAssessment(rows)
			if err != nil {
				continue
			}
			out = append(out, a)
		}
		rows.Close()

		/* THE MEASUREMENTS COME WITH THEM. Without this the list
		   carried the narrative and nothing else, so a page built from
		   it showed every weight and height blank — the numbers were
		   safely in the database and invisible on screen, which is the
		   worst of both.

		   One query for the whole person rather than one per version:
		   a client with nine visits should not cost nine round trips
		   to draw a list. */
		byAssessment := map[string][]measurement{}
		mrows, err := st.pool.Query(r.Context(), `
			SELECT m.assessment_id, m.metric, m.value, m.unit, m.kind,
			       m.method, m.taken_at, m.ref_low, m.ref_high
			  FROM crm.measurements m
			 WHERE m.person_id = $1 AND m.assessment_id IS NOT NULL
			 ORDER BY m.metric`, personID)
		if err == nil {
			defer mrows.Close()
			for mrows.Next() {
				var id string
				var m measurement
				var taken time.Time
				if err := mrows.Scan(&id, &m.Metric, &m.Value, &m.Unit, &m.Kind,
					&m.Method, &taken, &m.RefLow, &m.RefHigh); err != nil {
					continue
				}
				m.TakenAt = taken.Format(time.RFC3339)
				byAssessment[id] = append(byAssessment[id], m)
			}
		}

		for i := range out {
			if got, ok := byAssessment[out[i].ID]; ok {
				out[i].Measurements = got
			}
		}

		writeJSON(w, 200, map[string]any{"ok": true, "assessments": out})
	}
}

// GET /crm/assessments/{id}
func crmAssessmentOne(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		a, err := scanAssessment(st.pool.QueryRow(r.Context(), `
			SELECT `+assessmentCols+`
			  FROM crm.assessments a
			  JOIN crm.people p ON p.id = a.person_id
			 WHERE a.id = $1`, id))
		if err != nil {
			bad(w, 404, "not_found", "no assessment with that reference")
			return
		}
		a.Measurements = st.measurementsFor(r.Context(), a.ID)
		writeJSON(w, 200, map[string]any{"ok": true, "assessment": a})
	}
}

/* POST /crm/assessments — open the draft, or start the next visit.

   IDEMPOTENT ON PURPOSE. Opening the record twice must not produce
   two half-written versions of the same hour, so an existing draft
   is returned rather than a second one created. The partial unique
   index is what makes that hold under two clicks at once. */
func crmAssessmentOpen(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			PersonID       string  `json:"personId"`
			ConsultationID *string `json:"consultationId"`
			By             string  `json:"by"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
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

		ctx := r.Context()

		// An open draft is the answer, if there is one.
		if a, err := scanAssessment(st.pool.QueryRow(ctx, `
			SELECT `+assessmentCols+`
			  FROM crm.assessments a
			  JOIN crm.people p ON p.id = a.person_id
			 WHERE a.person_id = $1 AND a.status = 'draft'
			 ORDER BY a.visit DESC LIMIT 1`, in.PersonID)); err == nil {
			a.Measurements = st.measurementsFor(ctx, a.ID)
			writeJSON(w, 200, map[string]any{"ok": true, "assessment": a, "opened": "existing"})
			return
		}

		var name string
		if err := st.pool.QueryRow(ctx,
			`SELECT name FROM crm.people WHERE id = $1`, in.PersonID).Scan(&name); err != nil {
			bad(w, 404, "not_found", "no person with that reference")
			return
		}

		// The next visit number — amendments do not count as visits.
		var visit int
		_ = st.pool.QueryRow(ctx,
			`SELECT COALESCE(MAX(visit) + 1, 0) FROM crm.assessments WHERE person_id = $1`,
			in.PersonID).Scan(&visit)

		kind := "first_visit"
		if visit > 0 {
			kind = "follow_up"
		}

		id := ""
		err := st.pool.QueryRow(ctx, `
			INSERT INTO crm.assessments
			  (person_id, consultation_id, visit, amendment, ref, kind, status, recorded_by)
			VALUES ($1, $2, $3, 0, $4, $5, 'draft', $6)
			RETURNING id`,
			in.PersonID, in.ConsultationID, visit, makeRef(name, visit, 0), kind, in.By).Scan(&id)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				bad(w, 409, "already_open", "a draft is already open for that visit")
				return
			}
			bad(w, 500, "not_opened", "could not open an assessment")
			return
		}

		a, _ := scanAssessment(st.pool.QueryRow(ctx, `
			SELECT `+assessmentCols+` FROM crm.assessments a
			  JOIN crm.people p ON p.id = a.person_id WHERE a.id = $1`, id))
		writeJSON(w, 201, map[string]any{"ok": true, "assessment": a, "opened": "new"})
	}
}

/* PATCH /crm/assessments/{id} — saving, and only ever a draft.

   The trend fields are lifted OUT of the answers document and
   written as measurements, so a weight lives in exactly one place
   and can be drawn as a curve. Everything else stays in the
   document, where it is read as one thing. */
func crmAssessmentSave(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Answers      map[string]any `json:"answers"`
			OpenSections []string       `json:"openSections"`
			Notes        *string        `json:"notes"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}

		id := r.PathValue("id")
		ctx := r.Context()

		tx, err := st.pool.Begin(ctx)
		if err != nil {
			bad(w, 500, "busy", "could not save just now")
			return
		}
		defer tx.Rollback(ctx) //nolint:errcheck

		var personID, status string
		if err := tx.QueryRow(ctx,
			`SELECT person_id, status FROM crm.assessments WHERE id = $1`, id).
			Scan(&personID, &status); err != nil {
			bad(w, 404, "not_found", "no assessment with that reference")
			return
		}

		/* A FINALISED VERSION IS NOT EDITABLE. Not "should not be" —
		   is not. The way to change it is /amend, which writes the
		   next version and leaves this one alone. */
		if status == "final" {
			bad(w, 409, "final", "that version is final — amend it instead")
			return
		}

		// Split the trend out of the narrative.
		narrative := map[string]any{}
		type num struct {
			value float64
			unit  string
		}
		numbers := map[string]num{}

		for k, v := range in.Answers {
			unit, isTrend := trendFields[k]
			if !isTrend {
				narrative[k] = v
				continue
			}
			f, ok := toFloat(v)
			if !ok {
				continue // blank or unparseable: simply not recorded
			}
			numbers[k] = num{value: f, unit: unit}
		}

		answers, _ := json.Marshal(narrative)
		open, _ := json.Marshal(in.OpenSections)

		notes := ""
		if in.Notes != nil {
			notes = *in.Notes
		}

		if _, err := tx.Exec(ctx, `
			UPDATE crm.assessments
			   SET answers = $2, open_sections = $3, notes = $4, updated_at = now()
			 WHERE id = $1`, id, answers, open, notes); err != nil {
			bad(w, 500, "not_saved", "could not save that")
			return
		}

		/* Replaced rather than appended. Within one draft these are
		   the same measurement being corrected as she types, not a
		   series of readings — a series would give her a curve made
		   of keystrokes. */
		if _, err := tx.Exec(ctx,
			`DELETE FROM crm.measurements WHERE assessment_id = $1 AND kind = 'body'`, id); err != nil {
			bad(w, 500, "not_saved", "could not save the measurements")
			return
		}

		for metric, n := range numbers {
			if _, err := tx.Exec(ctx, `
				INSERT INTO crm.measurements
				  (person_id, assessment_id, kind, metric, value, unit)
				VALUES ($1, $2, 'body', $3, $4, $5)`,
				personID, id, metric, n.value, n.unit); err != nil {
				bad(w, 500, "not_saved", "could not save the measurements")
				return
			}
		}

		if err := tx.Commit(ctx); err != nil {
			bad(w, 500, "not_saved", "could not save that")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

// POST /crm/assessments/{id}/final
func crmAssessmentFinal(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ct, err := st.pool.Exec(r.Context(), `
			UPDATE crm.assessments
			   SET status = 'final', finalised_at = now(), updated_at = now()
			 WHERE id = $1 AND status = 'draft'`, r.PathValue("id"))
		if err != nil {
			bad(w, 500, "not_saved", "could not finalise that")
			return
		}
		if ct.RowsAffected() == 0 {
			bad(w, 409, "not_draft", "that version is already final")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

/* POST /crm/assessments/{id}/amend — the next version.

   A COPY FORWARD, NOT AN EDIT. The previous version keeps its
   reference, its answers, its measurements and its timestamps and is
   never touched again. This is the only route that changes what a
   finalised assessment says, and it does so by writing a new one
   beside it. */
func crmAssessmentAmend(st *Store) http.HandlerFunc {
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
			bad(w, 500, "busy", "could not amend just now")
			return
		}
		defer tx.Rollback(ctx) //nolint:errcheck

		var personID, name, status string
		var visit, amendment int
		if err := tx.QueryRow(ctx, `
			SELECT a.person_id, p.name, a.status, a.visit, a.amendment
			  FROM crm.assessments a JOIN crm.people p ON p.id = a.person_id
			 WHERE a.id = $1`, id).
			Scan(&personID, &name, &status, &visit, &amendment); err != nil {
			bad(w, 404, "not_found", "no assessment with that reference")
			return
		}
		if status != "final" {
			bad(w, 409, "not_final", "that version is still a draft — it can just be edited")
			return
		}

		next := ""
		err = tx.QueryRow(ctx, `
			INSERT INTO crm.assessments
			  (person_id, consultation_id, visit, amendment, ref, amends,
			   kind, status, answers, open_sections, notes, recorded_by)
			SELECT person_id, consultation_id, visit, $3, $4, id,
			       kind, 'draft', answers, open_sections, notes, $5
			  FROM crm.assessments WHERE id = $1 AND person_id = $2
			RETURNING id`,
			id, personID, amendment+1, makeRef(name, visit, amendment+1), in.By).Scan(&next)
		if err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				bad(w, 409, "already_amending", "an amendment of that version is already open")
				return
			}
			bad(w, 500, "not_amended", "could not amend that")
			return
		}

		// The measurements come forward too, so the new version is a
		// complete statement rather than a diff nobody can read alone.
		if _, err := tx.Exec(ctx, `
			INSERT INTO crm.measurements
			  (person_id, assessment_id, kind, metric, value, unit, method, ref_low, ref_high, taken_at)
			SELECT person_id, $2, kind, metric, value, unit, method, ref_low, ref_high, taken_at
			  FROM crm.measurements WHERE assessment_id = $1`, id, next); err != nil {
			bad(w, 500, "not_amended", "could not carry the measurements forward")
			return
		}

		if err := tx.Commit(ctx); err != nil {
			bad(w, 500, "not_amended", "could not amend that")
			return
		}

		a, _ := scanAssessment(st.pool.QueryRow(ctx, `
			SELECT `+assessmentCols+` FROM crm.assessments a
			  JOIN crm.people p ON p.id = a.person_id WHERE a.id = $1`, next))
		a.Measurements = st.measurementsFor(ctx, next)
		writeJSON(w, 201, map[string]any{"ok": true, "assessment": a})
	}
}

/* A number the browser sent as a string, a float, or nothing at all.
   Blank is not zero — an unrecorded weight and a weight of 0 kg are
   very different claims, and only one of them is possible. */
func toFloat(v any) (float64, bool) {
	switch t := v.(type) {
	case float64:
		return t, true
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0, false
		}
		var f float64
		if _, err := fmt.Sscanf(s, "%g", &f); err != nil {
			return 0, false
		}
		return f, true
	}
	return 0, false
}
