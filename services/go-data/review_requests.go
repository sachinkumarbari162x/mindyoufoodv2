// Review requests — a client on a programme asking to be seen again
//
//	POST /programme/{token}/review        ask — PUBLIC, and it writes
//	GET  /programme/{token}/review        what they already asked — PUBLIC
//	POST /crm/consultations/{id}/schedule her answer: a time
//
// THE THIRD PUBLIC WRITE PATH in this service, after the check-in
// and the note. Same bounds as those two — a known programme, a
// length cap, nothing interpreted — and one more that neither of
// them needs: a client may have ONE open request at a time.
//
// WHY THAT LIMIT MATTERS. A check-in is one row a day and a note is
// a message; both are cheap to have too many of. A request is a
// line on the page she works from every morning, and somebody
// tapping twice because nothing visibly happened would put two
// there. So asking again returns the request already open rather
// than making another — the same mint-or-return the plan link and
// the programme itself use.
//
// IT ARRIVES WITH NO TIME ON IT, deliberately. The client is
// asking; she is offering. Letting them pick from her diary would
// mean exposing her free hours to a token holder, and the whole
// point of the front desk is that she confirms every booking
// herself.
package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

/* Long enough to say why they want to be seen, short enough that
   this cannot become a second messaging channel — that is what the
   notes thread is for, and it is on the same screen. */
const reviewNoteMax = 600

/* POST /programme/{token}/review — PUBLIC, and it writes. */
func programmeReviewAsk(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		progID, personID, planNo, ok := st.programmeFor(r, r.PathValue("token"))
		if !ok {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}
		_ = progID

		var in struct {
			Note string `json:"note"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in)

		note := strings.TrimSpace(in.Note)
		if len(note) > reviewNoteMax {
			note = note[:reviewNoteMax]
		}

		ctx := r.Context()

		/* ALREADY WAITING? Anything held or confirmed and still
		   ahead of them means there is nothing to add — a client
		   with a session on Thursday does not need a second one
		   because they pressed the button again on Tuesday. */
		var existing consultationBrief
		err := st.pool.QueryRow(ctx, `
			SELECT id, status, source, scheduled_start_at, created_at
			  FROM crm.consultations
			 WHERE person_id = $1
			   AND status IN ('held', 'confirmed')
			   AND (scheduled_start_at IS NULL OR scheduled_start_at > now())
			 ORDER BY created_at DESC
			 LIMIT 1`, personID).
			Scan(&existing.ID, &existing.Status, &existing.Source,
				&existing.StartAt, &existing.CreatedAt)
		if err == nil {
			writeJSON(w, 200, map[string]any{
				"ok": true, "already": true, "request": existing.out(),
			})
			return
		}

		/* The plan they are following, so the row she reads says what
		   this is about rather than "Review". */
		var planRef string
		_ = st.pool.QueryRow(ctx, `
			SELECT ref FROM crm.plans
			 WHERE person_id = $1 AND plan_no = $2 AND status = 'issued'
			 ORDER BY amendment DESC LIMIT 1`, personID, planNo).Scan(&planRef)

		issue := "Review of their plan"
		if planRef != "" {
			issue = "Review of " + planRef
		}

		var made consultationBrief
		if err := st.pool.QueryRow(ctx, `
			INSERT INTO crm.consultations
			  (person_id, issue, mode, status, source, notes)
			VALUES ($1, $2, 'video', 'held', 'review', $3)
			RETURNING id, status, source, scheduled_start_at, created_at`,
			personID, issue, note).
			Scan(&made.ID, &made.Status, &made.Source, &made.StartAt, &made.CreatedAt); err != nil {
			bad(w, 500, "not_saved", "could not send that")
			return
		}

		writeJSON(w, 201, map[string]any{"ok": true, "already": false, "request": made.out()})
	}
}

/* GET /programme/{token}/review — PUBLIC.

   What they asked for, so the app can say "you asked on Tuesday"
   rather than offering a button that does nothing. Returns the
   least it can: whether something is open, and when it is if she
   has given it a time. */
func programmeReviewState(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_, personID, _, ok := st.programmeFor(r, r.PathValue("token"))
		if !ok {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}

		var c consultationBrief
		err := st.pool.QueryRow(r.Context(), `
			SELECT id, status, source, scheduled_start_at, created_at
			  FROM crm.consultations
			 WHERE person_id = $1
			   AND status IN ('held', 'confirmed')
			   AND (scheduled_start_at IS NULL OR scheduled_start_at > now())
			 ORDER BY created_at DESC
			 LIMIT 1`, personID).
			Scan(&c.ID, &c.Status, &c.Source, &c.StartAt, &c.CreatedAt)

		if err != nil {
			writeJSON(w, 200, map[string]any{"ok": true, "request": nil})
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "request": c.out()})
	}
}

/* The little that a client may know about their own request. No id
   reaches them — see GET /api/programme/review in the BFF, which
   strips it. */
type consultationBrief struct {
	ID        string
	Status    string
	Source    string
	StartAt   *time.Time
	CreatedAt time.Time
}

func (c consultationBrief) out() map[string]any {
	return map[string]any{
		"id":        c.ID,
		"status":    c.Status,
		"source":    c.Source,
		"startAt":   ts(c.StartAt),
		"askedAt":   c.CreatedAt.Format(time.RFC3339),
		"scheduled": c.StartAt != nil,
	}
}

/* POST /crm/consultations/{id}/schedule — her answer.

   Puts a time on a request that arrived without one and confirms
   it in the same statement. Hers, behind the session.

   ONLY ON A TIMELESS ONE. `scheduled_start_at IS NULL` is in the
   WHERE clause rather than in an if above it, because this must
   never become a second way to move an appointment somebody has
   already been told about — that is what a reschedule is, it
   records an outcome, and it belongs in outcomes.go where the
   record of the move is written. */
func crmConsultationSchedule(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			StartAt string `json:"startAt"`
			Minutes int    `json:"minutes"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}

		start, err := time.Parse(time.RFC3339, in.StartAt)
		if err != nil {
			bad(w, 400, "invalid", "that is not a time")
			return
		}
		if start.Before(time.Now()) {
			bad(w, 400, "in_the_past", "that hour has gone")
			return
		}
		if in.Minutes <= 0 || in.Minutes > 240 {
			in.Minutes = 60
		}

		tag, err := st.pool.Exec(r.Context(), `
			UPDATE crm.consultations
			   -- EVERY PLACEHOLDER SAYS ITS OWN TYPE, and both of these
			   -- were learned the hard way. Postgres deduces ONE type
			   -- per parameter across the whole statement, so $2 read
			   -- once as a column assignment and again inside an
			   -- addition came back "inconsistent types deduced for
			   -- parameter $2". And the minutes are make_interval
			   -- rather than string concatenation because $3 is an
			   -- integer on this side: (n || ' minutes') has no unique
			   -- operator in Postgres, and casting the parameter to
			   -- text instead made pgx refuse to encode the int.
			   --
			   -- Neither failure is visible in Go. The statement simply
			   -- never runs, which is why the error below is logged.
			   SET scheduled_start_at = $2::timestamptz,
			       scheduled_end_at   = $2::timestamptz + make_interval(mins => $3::int),
			       status             = 'confirmed',
			       confirmed_at       = COALESCE(confirmed_at, now()),
			       hold_expires_at    = NULL,
			       updated_at         = now()
			 WHERE id = $1
			   AND scheduled_start_at IS NULL
			   AND status = 'held'`, r.PathValue("id"), start, in.Minutes)

		if err != nil {
			/* THE GUARD WORKING AND A FAULT ARE NOT THE SAME THING,
			   and this handler used to answer both with "that hour
			   has just been taken". It said that for a column that
			   did not exist, which sent her hunting through her own
			   diary for a clash there was no sign of.

			   23505 / 23P01 is the partial unique index refusing a
			   double booking — she picked an hour that filled
			   between the page loading and the tap, and "pick
			   another" is exactly right. Anything else is ours, and
			   it says so plainly and lands in the log where it can
			   be read. */
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && (pgErr.Code == "23505" || pgErr.Code == "23P01") {
				bad(w, 409, "slot_taken", "that hour has just been taken — pick another")
				return
			}
			log.Printf("[go-data] schedule failed for %s: %v", r.PathValue("id"), err)
			bad(w, 500, "not_saved", "could not put a time on that")
			return
		}
		if tag.RowsAffected() == 0 {
			bad(w, 409, "not_schedulable",
				"that request already has a time — move it from the session itself")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}
