// Plan items — a model's reading of her plan, and her verdict on it
//
//	GET    /crm/plan-items?planId=      every row, in reading order
//	POST   /crm/plan-items              read the plan again, and reconcile
//	PATCH  /crm/plan-items/{id}         her verdict: confirm, edit, reject
//	DELETE /crm/plan-items/{id}         throw away a row she has not ruled on
//
// NOTHING HERE IS PART OF A PLAN UNTIL SHE SAYS SO. Rows arrive as
// 'proposed' with nobody attached, and the CHECK constraint in
// migration 0022 refuses a confirmed row without a name and a time
// on it. That is deliberately not enforceable from this file alone:
// a later handler that forgets is stopped by the database.
//
// AND THE ORIGINAL IS NEVER OVERWRITTEN. `proposed` is frozen when
// the model answers. Editing a row changes the columns beside it and
// leaves that jsonb alone, because the difference between the two is
// the only evidence we will ever have of how well this works.
package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode"
)

type planItem struct {
	ID          string          `json:"id"`
	PlanID      string          `json:"planId"`
	Seq         int             `json:"seq"`
	SourceLine  *int            `json:"sourceLine"`
	Kind        string          `json:"kind"`
	Label       string          `json:"label"`
	Quantity    *float64        `json:"quantity"`
	Unit        string          `json:"unit"`
	Schedule    string          `json:"schedule"`
	Detail      json.RawMessage `json:"detail"`
	Proposed    json.RawMessage `json:"proposed"`
	Status      string          `json:"status"`
	Model       string          `json:"model"`
	ConfirmedBy *string         `json:"confirmedBy"`
	ConfirmedAt *string         `json:"confirmedAt"`
}

const planItemCols = `
	id, plan_id, seq, source_line, kind, label, quantity, unit, schedule,
	detail, proposed, status, model, confirmed_by, confirmed_at`

func scanPlanItems(rows interface {
	Next() bool
	Scan(...any) error
	Close()
}) []planItem {
	defer rows.Close()
	out := []planItem{}
	for rows.Next() {
		var it planItem
		var confirmed *time.Time
		if err := rows.Scan(&it.ID, &it.PlanID, &it.Seq, &it.SourceLine, &it.Kind,
			&it.Label, &it.Quantity, &it.Unit, &it.Schedule, &it.Detail, &it.Proposed,
			&it.Status, &it.Model, &it.ConfirmedBy, &confirmed); err != nil {
			continue
		}
		it.ConfirmedAt = ts(confirmed)
		out = append(out, it)
	}
	return out
}

// GET /crm/plan-items?planId=
func crmPlanItemList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		planID := r.URL.Query().Get("planId")
		if planID == "" {
			bad(w, 400, "invalid", "a plan is needed")
			return
		}
		rows, err := st.pool.Query(r.Context(),
			`SELECT `+planItemCols+` FROM crm.plan_items
			  WHERE plan_id = $1 AND cleared_at IS NULL ORDER BY seq`, planID)
		if err != nil {
			bad(w, 500, "read_failed", "could not read those")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "items": scanPlanItems(rows)})
	}
}

/* How many times the assistant may read one version of a plan.

   Not a cost control, though it is that too. It is that the fourth
   read of unchanged text says nothing the first three did not: if a
   sentence has been misread three times, the sentence is the
   problem and the fix is to rewrite the line. A button with no
   limit invites exactly the wrong response to a bad answer.

   An amendment starts a new row and therefore a new three. */
const planReadCap = 3

/* And a separate three for writing a first draft out of the
   finalised assessment. A different job with a different cost —
   migration 0029 sets out why the two budgets must not be pooled. */
const planDraftCap = 3

/* Two labels are the same row when they say the same thing. Case,
   spacing and punctuation all move about between two readings of one
   sentence — the model writes "Breakfast: two eggs" once and
   "breakfast - two eggs" the next time — and none of that is a
   different instruction. Stripping to letters and digits is crude and
   it is exactly crude enough: it will not match two genuinely
   different rows, and that is the failure that matters. A false match
   would silently swallow a new instruction; a missed match only adds
   a row she can see and delete. */
func matchKey(label string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(label) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

/* POST /crm/plan-items — read the plan again, and RECONCILE.

   THIS USED TO REPLACE, AND THAT WAS THE BUG. It deleted every
   untouched proposal and inserted the fresh reading — correct in
   isolation, and wrong the moment she had confirmed anything. Her
   confirmed rows survived the delete (they are her work) and the
   re-read proposed all of them again, so pressing "Read the plan" a
   second time left the panel holding two of everything. The button
   was effectively single-use.

   So it now compares instead. For every row the model returns:

     already there, still just a proposal  → refreshed in place
     already there, and she has ruled on it → LEFT ALONE. Her verdict
                                             is the point; a re-read
                                             does not get to reopen it
     not there at all                       → added as a new proposal

   And for rows that were there before:

     a proposal the text no longer supports → removed
     a row she ruled on that is no longer
       in the text                          → KEPT, and moved to the
                                             end. Deleting somebody's
                                             confirmed row because a
                                             model stopped mentioning
                                             it is not a tidy-up

   The effect is that pressing the button twice on unchanged text
   changes nothing at all, and pressing it after editing the plan
   updates what moved and adds what is new. Which is what she would
   expect a button called "Read the plan" to do. */
func crmPlanItemsRead(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			PlanID string `json:"planId"`
			Model  string `json:"model"`
			Items  []struct {
				Line     *int     `json:"line"`
				Kind     string   `json:"kind"`
				Label    string   `json:"label"`
				Quantity *float64 `json:"quantity"`
				Unit     string   `json:"unit"`
				Schedule string   `json:"schedule"`

				/* HOW IT IS ACTUALLY TAKEN. These go into
				   plan_items.detail rather than into columns of their
				   own: they are kind-specific — a supplement has a
				   timing and a walk does not — and a table with a
				   column for every kind's fields is a table that is
				   mostly NULL and gains one every time she wants
				   something new said on a row.

				   The column has existed since the client panel was
				   built and nothing wrote to it until now; the seeded
				   clients filled it by hand. This is the path that
				   fills it for real. */
				Household   string   `json:"household"`
				How         string   `json:"how"`
				Timing      string   `json:"timing"`
				GapMinutes  *int     `json:"gapMinutes"`
				Sets        *int     `json:"sets"`
				Reps        string   `json:"reps"`
				RestSeconds *int     `json:"restSeconds"`
			} `json:"items"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.PlanID == "" {
			bad(w, 400, "invalid", "a plan is needed")
			return
		}

		ctx := r.Context()

		/* Only an open draft may be re-read. Once a plan is issued the
		   client has it, and rewriting the rows beneath a document
		   somebody is already following would make the two disagree
		   with nothing to say which is right. */
		var status string
		if err := st.pool.QueryRow(ctx,
			`SELECT status FROM crm.plans WHERE id = $1`, in.PlanID).Scan(&status); err != nil {
			bad(w, 404, "not_found", "no plan with that reference")
			return
		}
		if status != "draft" {
			bad(w, 409, "not_draft", "that plan has been issued — amend it before re-reading it")
			return
		}

		/* NO CAP HERE ANY MORE, and its absence is deliberate.

		   This route writes rows. It used to also count them against
		   the three-reads limit, which was the wrong event: Build
		   writes rows by parsing structured text with no model at
		   all, and charging that against a model budget would mean
		   she could not rebuild her own table.

		   The cap moved to POST /crm/plans/{id}/read, claimed by the
		   BFF after a model has actually answered — see plans.go. */

		tx, err := st.pool.Begin(ctx)
		if err != nil {
			bad(w, 500, "not_saved", "could not save those")
			return
		}
		defer tx.Rollback(ctx)

		/* What is already there. Read inside the transaction so a
		   second press arriving while the first is still running
		   cannot read a half-written panel. */
		type existing struct {
			id     string
			status string
			used   bool
		}
		rows, err := tx.Query(ctx,
			`SELECT id, label, status FROM crm.plan_items
			  WHERE plan_id = $1 AND cleared_at IS NULL ORDER BY seq`, in.PlanID)
		if err != nil {
			bad(w, 500, "not_saved", "could not read the rows already there")
			return
		}
		byKey := map[string]*existing{}
		all := []*existing{}
		for rows.Next() {
			var id, label, status string
			if err := rows.Scan(&id, &label, &status); err != nil {
				continue
			}
			ex := &existing{id: id, status: status}
			all = append(all, ex)
			// First one wins: if the panel already holds two rows that
			// say the same thing, the later is a duplicate to clear.
			if _, seen := byKey[matchKey(label)]; !seen {
				byKey[matchKey(label)] = ex
			}
		}
		rows.Close()

		var added, refreshed, kept int
		seq := 0

		for _, it := range in.Items {
			if it.Label == "" {
				continue
			}
			/* The frozen copy. Written from the same values as the
			   columns beside it, in this one statement, so there is no
			   moment where the two could be built from different
			   inputs. */
			frozen, _ := json.Marshal(map[string]any{
				"line": it.Line, "kind": it.Kind, "label": it.Label,
				"quantity": it.Quantity, "unit": it.Unit, "schedule": it.Schedule,
				"household": it.Household, "how": it.How, "timing": it.Timing,
				"gapMinutes": it.GapMinutes, "sets": it.Sets,
				"reps": it.Reps, "restSeconds": it.RestSeconds,
			})

			/* EMPTY FIELDS ARE ABSENT, not present and null. The
			   client's panel reads `detail.timing` and asks whether
			   there is one; a key sitting there holding "" is a
			   question that answers yes and then shows nothing. */
			detail := map[string]any{}
			if it.Household != "" {
				detail["household"] = it.Household
			}
			if it.How != "" {
				detail["how"] = it.How
			}
			if it.Timing != "" {
				detail["timing"] = it.Timing
			}
			if it.GapMinutes != nil {
				detail["gapMinutes"] = *it.GapMinutes
			}
			if it.Sets != nil {
				detail["sets"] = *it.Sets
			}
			if it.Reps != "" {
				detail["reps"] = it.Reps
			}
			if it.RestSeconds != nil {
				detail["restSeconds"] = *it.RestSeconds
			}
			detailJSON, _ := json.Marshal(detail)

			ex, found := byKey[matchKey(it.Label)]
			if found && !ex.used {
				ex.used = true

				if ex.status == "proposed" {
					/* Still just a proposal, so the fresh reading wins
					   — including `proposed`, which is refrozen because
					   this IS the model's current answer for this row. */
					if _, err := tx.Exec(ctx, `
						UPDATE crm.plan_items SET
						  seq = $2, source_line = $3, kind = $4, label = $5,
						  quantity = $6, unit = $7, schedule = $8,
						  proposed = $9, model = $10, detail = $11
						 WHERE id = $1`,
						ex.id, seq, it.Line, it.Kind, it.Label, it.Quantity,
						it.Unit, it.Schedule, frozen, in.Model, detailJSON); err != nil {
						bad(w, 500, "not_saved", "could not save those")
						return
					}
					refreshed++
				} else {
					/* SHE HAS RULED ON THIS ONE. Only its position
					   moves, so a reordered plan reorders the panel —
					   nothing about what it says or who confirmed it is
					   touched by a machine reading the text again. */
					if _, err := tx.Exec(ctx,
						`UPDATE crm.plan_items SET seq = $2 WHERE id = $1`, ex.id, seq); err != nil {
						bad(w, 500, "not_saved", "could not save those")
						return
					}
					kept++
				}
				seq++
				continue
			}

			if _, err := tx.Exec(ctx, `
				INSERT INTO crm.plan_items
				  (plan_id, seq, source_line, kind, label, quantity, unit, schedule,
				   proposed, status, model, detail)
				VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'proposed', $10, $11)`,
				in.PlanID, seq, it.Line, it.Kind, it.Label, it.Quantity,
				it.Unit, it.Schedule, frozen, in.Model, detailJSON); err != nil {
				bad(w, 500, "not_saved", "could not save those")
				return
			}
			added++
			seq++
		}

		/* WHAT THE NEW READING DID NOT MENTION.

		   An untouched proposal goes: the sentence behind it is no
		   longer in the plan, and leaving it would mean the panel
		   describes a document that no longer exists.

		   A row she ruled on stays, and moves to the end. She
		   confirmed it; a model failing to mention it on a second
		   pass is a fact about the model. */
		var gone int
		for _, ex := range all {
			if ex.used {
				continue
			}
			if ex.status == "proposed" {
				if _, err := tx.Exec(ctx, `DELETE FROM crm.plan_items WHERE id = $1`, ex.id); err != nil {
					bad(w, 500, "not_saved", "could not save those")
					return
				}
				gone++
				continue
			}
			if _, err := tx.Exec(ctx,
				`UPDATE crm.plan_items SET seq = $2 WHERE id = $1`, ex.id, seq); err != nil {
				bad(w, 500, "not_saved", "could not save those")
				return
			}
			seq++
		}


		if err := tx.Commit(ctx); err != nil {
			bad(w, 500, "not_saved", "could not save those")
			return
		}
		/* What the reading actually did. Sent back so the panel can
		   say "3 new, 5 unchanged" rather than redrawing silently and
		   leaving her to diff two screens in her head. */
		changed := map[string]int{
			"added": added, "refreshed": refreshed, "kept": kept, "gone": gone,
		}

		out, err := st.pool.Query(ctx,
			`SELECT `+planItemCols+` FROM crm.plan_items
			  WHERE plan_id = $1 AND cleared_at IS NULL ORDER BY seq`, in.PlanID)
		if err != nil {
			writeJSON(w, 200, map[string]any{"ok": true, "items": []planItem{}, "changed": changed})
			return
		}
		writeJSON(w, 201, map[string]any{
			"ok": true, "items": scanPlanItems(out), "changed": changed,
		})
	}
}

/* PATCH /crm/plan-items/{id} — her verdict.

   The three answers are confirm, edit and reject, and the difference
   between the first two is recorded rather than inferred: 'confirmed'
   means she agreed with it as written, 'edited' means she agreed
   after changing it. Collapsing them would throw away exactly the
   number this phase exists to produce. */
func crmPlanItemVerdict(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Status   string   `json:"status"`
			Kind     *string  `json:"kind"`
			Label    *string  `json:"label"`
			Quantity *float64 `json:"quantity"`
			Unit     *string  `json:"unit"`
			Schedule *string  `json:"schedule"`
			By       string   `json:"by"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		switch in.Status {
		case "confirmed", "edited", "rejected", "proposed":
		default:
			bad(w, 400, "invalid", "that is not an answer")
			return
		}
		if in.By == "" {
			in.By = "unknown"
		}

		/* Who and when are attached here and only here, and only for
		   the two statuses that mean she agreed. The database refuses
		   the alternative, so this cannot drift. */
		var by any
		var at any
		if in.Status == "confirmed" || in.Status == "edited" {
			by, at = in.By, time.Now()
		}

		tag, err := st.pool.Exec(r.Context(), `
			UPDATE crm.plan_items SET
			  status       = $2,
			  kind         = COALESCE($3, kind),
			  label        = COALESCE($4, label),
			  quantity     = CASE WHEN $5::numeric IS NULL THEN quantity ELSE $5 END,
			  unit         = COALESCE($6, unit),
			  schedule     = COALESCE($7, schedule),
			  confirmed_by = $8,
			  confirmed_at = $9
			 WHERE id = $1
			   AND plan_id IN (SELECT id FROM crm.plans WHERE status = 'draft')`,
			r.PathValue("id"), in.Status, in.Kind, in.Label, in.Quantity,
			in.Unit, in.Schedule, by, at)
		if err != nil {
			bad(w, 500, "not_saved", "could not record that")
			return
		}
		if tag.RowsAffected() == 0 {
			bad(w, 409, "not_editable", "that plan has been issued — its rows are settled")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

/* GET /crm/plan-items/accuracy — how often the assistant is right.

   The whole justification for phase three. Counted over every row
   she has ruled on, grouped by model, so switching models does not
   quietly inherit the previous one's reputation. */
func crmPlanItemAccuracy(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		/* THE ONE READ THAT DOES NOT SKIP CLEARED ROWS, and it is
		   deliberate. A rejection she later swept off her table is
		   still a rejection that happened, and dropping it from this
		   count would let the assistant's accuracy figure improve
		   every time somebody tidied up. See migration 0006. */
		rows, err := st.pool.Query(r.Context(), `
			SELECT COALESCE(NULLIF(model, ''), 'unknown') AS model,
			       COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed,
			       COUNT(*) FILTER (WHERE status = 'edited')    AS edited,
			       COUNT(*) FILTER (WHERE status = 'rejected')  AS rejected,
			       COUNT(*) FILTER (WHERE status = 'proposed')  AS pending,
			       COUNT(*) AS total
			  FROM crm.plan_items
			 GROUP BY 1
			 ORDER BY total DESC`)
		if err != nil {
			bad(w, 500, "read_failed", "could not read that")
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var model string
			var confirmed, edited, rejected, pending, total int
			if err := rows.Scan(&model, &confirmed, &edited, &rejected, &pending, &total); err != nil {
				continue
			}
			judged := confirmed + edited + rejected
			// Only rows she has looked at can say anything about accuracy.
			var rate *float64
			if judged > 0 {
				v := float64(confirmed) / float64(judged)
				rate = &v
			}
			out = append(out, map[string]any{
				"model": model, "confirmed": confirmed, "edited": edited,
				"rejected": rejected, "pending": pending, "total": total,
				"judged": judged, "untouchedRate": rate,
			})
		}
		writeJSON(w, 200, map[string]any{"ok": true, "accuracy": out})
	}
}

/* DELETE /crm/plan-items/{id} — throw a proposal away.

   ONLY A ROW SHE HAS NOT RULED ON, and the WHERE clause says so
   rather than an if above it. The reason is the accuracy figure: a
   proposal carries no judgement, so deleting it loses nothing, while
   a row she marked wrong is the evidence that it WAS wrong. Deleting
   those would quietly walk the assistant's score upwards every time
   it got something wrong badly enough to annoy her — a measurement
   that improves as the thing it measures gets worse.

   So "No" is how a bad row stops counting, and this is how a row that
   should never have been in the panel leaves it. The two are
   different acts and the panel offers both.

   Only on a draft, like every other write to these rows. */
func crmPlanItemDrop(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tag, err := st.pool.Exec(r.Context(), `
			DELETE FROM crm.plan_items
			 WHERE id = $1
			   AND status = 'proposed'
			   AND plan_id IN (SELECT id FROM crm.plans WHERE status = 'draft')`,
			r.PathValue("id"))
		if err != nil {
			bad(w, 500, "not_deleted", "could not remove that")
			return
		}
		if tag.RowsAffected() == 0 {
			/* Gone already, ruled on, or on an issued plan. One
			   message, because in every case the answer is the same:
			   this is not a row to delete. */
			bad(w, 409, "not_removable", "only a row you have not ruled on can be removed")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

/* DELETE /crm/plan-items?planId= — clear the reading and start again.

   A whole-panel version of the per-row delete above, and it obeys
   the same rule for the same reason: ONLY ROWS SHE HAS NOT RULED
   ON GO. A confirmed row is her work and a rejected one is the
   evidence that the assistant got something wrong — sweeping both
   away with a button would walk the accuracy figure upwards every
   time a reading annoyed her enough to clear it.

   WHAT IT IS FOR. The assistant misreads a plan, she edits the
   wording, and the panel is now half old proposals and half new
   ones. Deleting six rows one at a time to get a clean read is the
   kind of chore that ends with somebody issuing a plan they did not
   properly check.

   The count comes back so the page can say what it kept.
*/
func crmPlanItemsClear(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		planID := r.URL.Query().Get("planId")
		if planID == "" {
			bad(w, 400, "invalid", "a plan is needed")
			return
		}

		var status string
		if err := st.pool.QueryRow(r.Context(),
			`SELECT status FROM crm.plans WHERE id = $1`, planID).Scan(&status); err != nil {
			bad(w, 404, "not_found", "no plan with that reference")
			return
		}
		if status != "draft" {
			bad(w, 409, "not_draft", "that plan has been issued — its rows are settled")
			return
		}

		/* EVERYTHING SHE HAS NOT KEPT, which is not the same as
		   everything she has not ruled on.

		   This used to delete `status = 'proposed'` only. A row she
		   had looked at and REJECTED counted as ruled on, so it
		   stayed — and the ordinary sequence of reading a bad plan,
		   marking the wrong rows wrong, then pressing Clear, ended
		   with a table of rejections and a button that had nothing
		   left to do. Every row was junk and none of it could go.

		   Cleared rather than deleted: the accuracy figure counts
		   rejections and must not lose them. See migration 0006. */
		tag, err := st.pool.Exec(r.Context(), `
			UPDATE crm.plan_items
			   SET cleared_at = now()
			 WHERE plan_id = $1
			   AND cleared_at IS NULL
			   AND status IN ('proposed', 'rejected')`, planID)
		if err != nil {
			bad(w, 500, "not_deleted", "could not clear those")
			return
		}

		var kept int
		_ = st.pool.QueryRow(r.Context(),
			`SELECT COUNT(*) FROM crm.plan_items
			  WHERE plan_id = $1 AND cleared_at IS NULL`, planID).Scan(&kept)

		writeJSON(w, 200, map[string]any{
			"ok": true, "cleared": tag.RowsAffected(), "kept": kept,
		})
	}
}
