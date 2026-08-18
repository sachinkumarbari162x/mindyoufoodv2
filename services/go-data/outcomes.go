// Consultation outcomes — what happened after the booking
//
//	POST /crm/consultations/{id}/outcome   record one
//	GET  /crm/outcomes                     read them back
//	GET  /crm/outcomes/stats               counts by kind
//
// The consultation's own status says whether the BOOKING was
// accepted. This says whether the APPOINTMENT happened, and the two
// genuinely differ: a confirmed booking can end in a no-show.
package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// POST /crm/consultations/{id}/outcome
func crmOutcomeAdd(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Outcome string  `json:"outcome"`
			MovedTo *string `json:"movedTo"`
			Note    string  `json:"note"`
			By      string  `json:"by"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}

		switch in.Outcome {
		case "done", "rescheduled", "cancelled", "no_show":
		default:
			bad(w, 400, "invalid", "outcome must be done, rescheduled, cancelled or no_show")
			return
		}
		if in.Outcome == "rescheduled" && (in.MovedTo == nil || *in.MovedTo == "") {
			// The CHECK would refuse this anyway; saying it here gets
			// her a sentence instead of a constraint violation.
			bad(w, 400, "needs_a_time", "a reschedule needs the time it moved to")
			return
		}
		if in.By == "" {
			in.By = "unknown"
		}

		id := r.PathValue("id")
		ctx := r.Context()

		/* ONE TRANSACTION, because two facts are being written and a
		   half-written pair is worse than neither.

		   The outcomes table is the history; crm.consultations.status
		   is where the appointment stands now. If the history said
		   "cancelled" and the status still said "confirmed", the hour
		   would stay blocked against a cancelled session forever — and
		   the row would sit on Today with nothing left to do to it. */
		tx, err := st.pool.Begin(ctx)
		if err != nil {
			bad(w, 500, "busy", "could not record that just now")
			return
		}
		defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed

		var outID string
		err = tx.QueryRow(ctx, `
			INSERT INTO crm.consultation_outcomes
			  (consultation_id, outcome, was_scheduled_at, moved_to, note, recorded_by)
			SELECT c.id, $2, c.scheduled_start_at, $3::timestamptz, NULLIF($4,''), $5
			  FROM crm.consultations c
			 WHERE c.id = $1
			RETURNING id`,
			id, in.Outcome, in.MovedTo, in.Note, in.By).Scan(&outID)
		if err != nil {
			// No row means no such consultation, which is a 404 rather
			// than a fault in the request body.
			bad(w, 404, "not_found", "no consultation with that reference")
			return
		}

		/* A reschedule moves the appointment itself, so the booking
		   follows the outcome and STAYS confirmed — it is still going
		   to happen, at a different hour. The other three are endings,
		   and each has its own status already allowed by the CHECK on
		   crm.consultations.

		   WHAT THIS QUIETLY DOES: the partial unique index that blocks
		   a slot only counts 'held' and 'confirmed'. Moving off those
		   puts the hour back on offer within seconds — which is right
		   for a cancellation, and harmless for the other two, whose
		   time has already passed. */
		if in.Outcome == "rescheduled" {
			_, err = tx.Exec(ctx, `
				UPDATE crm.consultations
				   SET scheduled_start_at = $2::timestamptz,
				       scheduled_end_at   = $2::timestamptz
				                            + (scheduled_end_at - scheduled_start_at)
				 WHERE id = $1 AND scheduled_start_at IS NOT NULL`, id, *in.MovedTo)
		} else {
			status := map[string]string{
				"done":      "completed",
				"cancelled": "cancelled",
				"no_show":   "no_show",
			}[in.Outcome]
			_, err = tx.Exec(ctx, `
				UPDATE crm.consultations SET status = $2 WHERE id = $1`, id, status)
		}
		if err != nil {
			/* Named only when the database says so — a clash on the
			   partial unique index means she moved somebody onto an
			   hour taken between the page loading and her tapping it.
			   The whole thing rolls back either way, so there is never
			   an outcome recorded for a move that did not happen. */
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23P01") {
				bad(w, 409, "time_taken", "that hour was booked a moment ago — pick another")
				return
			}
			log.Printf("[outcome] %s on %s failed: %v", in.Outcome, id, err)
			bad(w, 500, "not_saved", "that did not save — try once more")
			return
		}

		if err := tx.Commit(ctx); err != nil {
			bad(w, 500, "not_saved", "that did not save — try once more")
			return
		}

		writeJSON(w, 201, map[string]any{"ok": true, "id": outID})
	}
}

// GET /crm/outcomes?limit=&outcome=&consultationId=
func crmOutcomeList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := 100
		if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 500 {
			limit = n
		}

		rows, err := st.pool.Query(r.Context(), `
			SELECT o.id, o.outcome, o.was_scheduled_at, o.moved_to,
			       COALESCE(o.note,''), o.recorded_by, o.recorded_at,
			       p.name, p.email, COALESCE(p.phone,''),
			       COALESCE(p.country_iso2,''), c.mode, COALESCE(c.issue,''),
			       o.consultation_id
			  FROM crm.consultation_outcomes o
			  JOIN crm.consultations c ON c.id = o.consultation_id
			  JOIN crm.people p        ON p.id = c.person_id
			 WHERE ($1 = '' OR o.outcome = $1)
			   AND ($2 = '' OR o.consultation_id::text = $2)
			 ORDER BY o.recorded_at DESC
			 LIMIT $3`,
			r.URL.Query().Get("outcome"), r.URL.Query().Get("consultationId"), limit)
		if err != nil {
			bad(w, 500, "read_failed", "could not read the outcomes")
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var id, outcome, note, by, name, email string
			var phone, country, mode, issue, consultationID string
			var wasAt, movedTo *time.Time
			var at time.Time
			if err := rows.Scan(&id, &outcome, &wasAt, &movedTo, &note, &by, &at,
				&name, &email, &phone, &country, &mode, &issue, &consultationID); err != nil {
				continue
			}
			out = append(out, map[string]any{
				"id": id, "outcome": outcome, "note": note,
				"wasScheduledAt": ts(wasAt), "movedTo": ts(movedTo),
				"recordedBy": by, "recordedAt": at.Format(time.RFC3339),
				"name": name, "email": email, "phone": phone, "country": country,
				"mode": mode, "issue": issue, "consultationId": consultationID,
			})
		}
		writeJSON(w, 200, map[string]any{"ok": true, "outcomes": out})
	}
}

/* DELETE /crm/outcomes/{id} — the undo behind a mis-tap

   This is the one place the history may be rewritten, and it is
   deliberate. She records an outcome with a single tap and no
   confirmation dialog, because a dialog taxes every correct tap to
   protect the rare wrong one; the price of that choice is that a
   wrong tap must be cheap to take back.

   TWO GUARDS keep it from becoming a way to edit the past:

     · only the LATEST outcome for that consultation, so a chain of
       moves cannot be unpicked from the middle;
     · only within five minutes, which is the length of a mistake.
       After that it is a record of something that happened, and the
       way to change it is to record what happened instead.

   A reschedule is put back to the hour it came from, which
   was_scheduled_at was stored to remember. */
func crmOutcomeUndo(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		id := r.PathValue("id")

		tx, err := st.pool.Begin(ctx)
		if err != nil {
			bad(w, 500, "busy", "could not undo that just now")
			return
		}
		defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed

		var consultationID, outcome string
		var wasAt *time.Time
		err = tx.QueryRow(ctx, `
			DELETE FROM crm.consultation_outcomes o
			 WHERE o.id = $1
			   AND o.recorded_at > now() - interval '5 minutes'
			   AND NOT EXISTS (
			         SELECT 1 FROM crm.consultation_outcomes later
			          WHERE later.consultation_id = o.consultation_id
			            AND later.recorded_at > o.recorded_at)
			RETURNING o.consultation_id, o.outcome, o.was_scheduled_at`,
			id).Scan(&consultationID, &outcome, &wasAt)
		if err != nil {
			bad(w, 409, "too_late", "that one has been recorded — record what happened instead")
			return
		}

		/* Back to confirmed, and back to the original hour if it moved.
		   Confirmed is right for all four: an accepted booking that has
		   had its outcome taken away is exactly a booking again. */
		if outcome == "rescheduled" && wasAt != nil {
			/* THE CASTS ARE LOAD-BEARING. Without them Postgres has to
			   infer the type of $2 while it is also the left side of an
			   addition with an interval, cannot, and rejects the whole
			   statement — which surfaced as an undo that always failed
			   and blamed a booking clash that had not happened. */
			_, err = tx.Exec(ctx, `
				UPDATE crm.consultations
				   SET status = 'confirmed',
				       scheduled_start_at = $2::timestamptz,
				       scheduled_end_at   = $2::timestamptz
				                            + (scheduled_end_at - scheduled_start_at)
				 WHERE id = $1`, consultationID, *wasAt)
		} else {
			_, err = tx.Exec(ctx, `
				UPDATE crm.consultations SET status = 'confirmed' WHERE id = $1`,
				consultationID)
		}
		if err != nil {
			/* Only ONE cause gets named, and only when the database has
			   actually said so. A message that guesses at a reason is
			   worse than one that admits it does not know: she reads
			   "the hour was booked", goes to look, finds it empty, and
			   now distrusts every message the system shows her. */
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23P01") {
				bad(w, 409, "time_taken", "the original hour has since been booked")
				return
			}
			log.Printf("[outcome] undo %s failed: %v", id, err)
			bad(w, 500, "not_undone", "could not undo that — try once more")
			return
		}

		if err := tx.Commit(ctx); err != nil {
			bad(w, 500, "not_saved", "the undo did not save")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "consultationId": consultationID})
	}
}

/* GET /crm/unrecorded — sessions whose hour has passed with nothing
   said about them.

   THIS IS WHAT MAKES THE BUTTONS MATTER. Recording an outcome is a
   single tap, but a single tap she is never reminded to make is one
   she will skip on a busy day — and a half-filled table answers no
   business question at all. So the gap chases her rather than
   waiting to be noticed.

   NO JOIN ON OUTCOMES, and that is not a shortcut. Recording moves a
   consultation off 'confirmed' in the same transaction, and a
   reschedule moves its hour into the future — so "still confirmed,
   hour already gone" IS the definition of unanswered. Deriving it
   from status rather than from the absence of a row means the two
   can never drift apart.

   BEFORE TODAY, not before now. A session at eleven this morning is
   already on the Today page with its buttons on it; listing it here
   as well would show her the same job twice under two names. This is
   only for the ones that have fallen off the end of the day, which
   otherwise appear on no page in the CRM at all — too old for Today,
   too past for Upcoming, and with no outcome to put them in
   History. */
func crmUnrecorded(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		/* The SAME reader every other consultation list uses, so an
		   overdue session arrives carrying its mode, its focus and the
		   ways to reach the person — it is drawn as a full row on
		   Today, not as a stub she then has to go and look up. */
		out, err := st.crmConsultations(r.Context(), "overdue", 50)
		if err != nil {
			bad(w, 500, "read_failed", "could not read those")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "sessions": out, "count": len(out)})
	}
}

// GET /crm/outcomes/stats — the question she will actually ask
func crmOutcomeStats(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := st.pool.Query(r.Context(), `
			SELECT outcome, count(*)
			  FROM crm.consultation_outcomes
			 WHERE recorded_at > now() - interval '90 days'
			 GROUP BY outcome`)
		if err != nil {
			bad(w, 500, "read_failed", "could not count those")
			return
		}
		defer rows.Close()

		counts := map[string]int{"done": 0, "rescheduled": 0, "cancelled": 0, "no_show": 0}
		for rows.Next() {
			var kind string
			var n int
			if err := rows.Scan(&kind, &n); err == nil {
				counts[kind] = n
			}
		}
		writeJSON(w, 200, map[string]any{"ok": true, "counts": counts})
	}
}
