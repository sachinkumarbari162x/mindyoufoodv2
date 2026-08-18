// Notes — the client saying something the plan has no box for
//
//	POST /programme/{token}/note      write one — PUBLIC, and it writes
//	GET  /programme/{token}/notes     their own, to draw the app — PUBLIC
//	GET  /crm/programme/notes?programmeId=   hers
//
// THIS IS THE SECOND PUBLIC WRITE PATH in the whole service, after
// the check-in, and it is the only one that takes free text. So the
// bounds are the same and then one more: a known programme, a date
// near today, and a length. Nothing here is interpreted, formatted
// or rendered as anything but text — it is stored as typed and it
// reaches her side through the same escaping as every other string.
//
// THE DATE IS THE DAY IT IS ABOUT. A note queued on a train belongs
// to the day it was written about, not the day the network came
// back, which is why the client sends it rather than the server
// stamping now().
package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

/* Long enough for somebody to explain a bad week, short enough that
   this cannot become a way to push a novel into her database. Cut
   rather than refused: losing the end of a long note is annoying,
   and being told "too long" after typing it is worse. */
const noteMax = 1200

type progNote struct {
	ID     string  `json:"id"`
	OnDate string  `json:"date"`
	Body   string  `json:"body"`
	At     string  `json:"at"`
	SeenAt *string `json:"seenAt"`

	// "client" or "practitioner". One table, two authors — see
	// migration 0027 for why this is a thread and not two tables.
	Author string  `json:"author"`
	By     *string `json:"by"`
}

/* POST /programme/{token}/note — PUBLIC, and it writes. */
func programmeNoteAdd(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		progID, _, _, ok := st.programmeFor(r, r.PathValue("token"))
		if !ok {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}

		var in struct {
			OnDate string `json:"onDate"`
			Body   string `json:"body"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}

		body := strings.TrimSpace(in.Body)
		if body == "" {
			bad(w, 400, "invalid", "there is nothing written in it")
			return
		}
		if len(body) > noteMax {
			body = body[:noteMax]
		}

		/* The same window as a check-in, and for the same reason —
		   see programmes.go. A note about last Tuesday is a memory
		   test; the tolerance is for timezones, not for backfilling. */
		day, err := time.Parse("2006-01-02", in.OnDate)
		if err != nil {
			bad(w, 400, "invalid", "that is not a date")
			return
		}
		today := time.Now().UTC().Truncate(24 * time.Hour)
		if day.After(today.AddDate(0, 0, 1)) || day.Before(today.AddDate(0, 0, -1)) {
			bad(w, 400, "out_of_range", "you can only write about today")
			return
		}

		var id string
		if err := st.pool.QueryRow(r.Context(), `
			INSERT INTO crm.programme_notes (programme_id, on_date, body)
			VALUES ($1, $2, $3)
			RETURNING id`, progID, day, body).Scan(&id); err != nil {
			bad(w, 500, "not_saved", "could not save that")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true, "id": id})
	}
}

const noteCols = `id, to_char(on_date, 'YYYY-MM-DD'), body, at, seen_at, author, by`

func scanNotes(rows interface {
	Next() bool
	Scan(...any) error
	Close()
}) []progNote {
	defer rows.Close()
	out := []progNote{}
	for rows.Next() {
		var n progNote
		var at time.Time
		var seen *time.Time
		if err := rows.Scan(&n.ID, &n.OnDate, &n.Body, &at, &seen, &n.Author, &n.By); err != nil {
			continue
		}
		n.At = at.Format(time.RFC3339)
		n.SeenAt = ts(seen)
		out = append(out, n)
	}
	return out
}

/* GET /programme/{token}/notes — PUBLIC. The whole thread.

   THEY SEE WHAT THEY SENT AND WHAT SHE ANSWERED. A box that swallows
   text and shows nothing back is one people stop trusting after the
   second time — there is no way to tell "sent" from "lost" — and a
   reply that never reaches the app is a reply she wasted her evening
   writing.

   Ordered oldest first, because this is a conversation and a
   conversation read bottom-up is a puzzle.

   WHAT IS WITHHELD: `by`. She is the only person who will ever
   answer, the app says her name in its own words, and a staff email
   address is not something a client link needs to carry. `seen_at`
   is stripped on HER lines for the same reason it always was — the
   app should not imply an answer about what she has read — but kept
   on their own, so "she has seen this" can be shown honestly.

   AND READING IT MARKS HER REPLIES READ. Same rule as her side. */
func programmeNotesList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		progID, _, _, ok := st.programmeFor(r, r.PathValue("token"))
		if !ok {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}
		rows, err := st.pool.Query(r.Context(), `
			SELECT `+noteCols+`
			  FROM crm.programme_notes
			 WHERE programme_id = $1
			 ORDER BY on_date DESC, at ASC
			 LIMIT 400`, progID)
		if err != nil {
			bad(w, 500, "read_failed", "could not read those")
			return
		}
		out := scanNotes(rows)
		for i := range out {
			out[i].By = nil
			if out[i].Author != "client" {
				out[i].SeenAt = nil
			}
		}

		_, _ = st.pool.Exec(r.Context(), `
			UPDATE crm.programme_notes
			   SET seen_at = now()
			 WHERE programme_id = $1 AND author = 'practitioner' AND seen_at IS NULL`, progID)

		writeJSON(w, 200, map[string]any{"ok": true, "notes": out})
	}
}

/* GET /crm/programme/notes?programmeId= — hers.

   Reading them MARKS THEM READ, in the same request. A separate
   "mark as seen" call is one more thing to forget to make, and the
   only honest meaning of seen_at is "this was sent to her screen". */
func crmProgrammeNotes(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("programmeId")
		if id == "" {
			bad(w, 400, "invalid", "a programme is needed")
			return
		}
		rows, err := st.pool.Query(r.Context(), `
			SELECT `+noteCols+`
			  FROM crm.programme_notes
			 WHERE programme_id = $1
			 ORDER BY on_date DESC, at DESC
			 LIMIT 300`, id)
		if err != nil {
			bad(w, 500, "read_failed", "could not read those")
			return
		}
		out := scanNotes(rows)

		/* AFTER the scan, not before it. The rows go back carrying the
		   seen_at they had when she opened the page, so a note reads as
		   new on the visit that first displayed it and is settled by
		   the next one. Marking first would mean nothing was ever new.

		   Failure here is ignored on purpose: not marking a note read
		   costs her a highlight she has already seen, and refusing to
		   return notes she asked for because a bookkeeping update
		   failed would be the wrong way round. */
		_, _ = st.pool.Exec(r.Context(), `
			UPDATE crm.programme_notes
			   SET seen_at = now()
			 WHERE programme_id = $1 AND author = 'client' AND seen_at IS NULL`, id)

		writeJSON(w, 200, map[string]any{"ok": true, "notes": out})
	}
}

/* POST /crm/programme/notes — HER REPLY.

   Behind her session, and the only route that writes a
   'practitioner' line. `by` comes from the session in the BFF and is
   required by the database, so a line in a client's record can never
   be traced to "the system".

   NO DATE WINDOW. The client may only write about today, because a
   check-in is a record of what somebody did and a memory test is
   worth nothing. A reply is not a record of a day — it is an answer
   about one — and she reads Tuesday's note on Thursday. Refusing
   that would make the feature useless in exactly the case it exists
   for.

   IT IS STILL BOUNDED BY THE PROGRAMME. The day must fall inside the
   window the programme actually covers, so a reply cannot be filed
   against a date the client's app will never show. */
func crmProgrammeReply(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ProgrammeID string `json:"programmeId"`
			OnDate      string `json:"onDate"`
			Body        string `json:"body"`
			By          string `json:"by"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}

		body := strings.TrimSpace(in.Body)
		if in.ProgrammeID == "" || body == "" {
			bad(w, 400, "invalid", "a programme and something to say are needed")
			return
		}
		if strings.TrimSpace(in.By) == "" {
			bad(w, 400, "invalid", "a reply has to have a name on it")
			return
		}
		if len(body) > noteMax {
			body = body[:noteMax]
		}

		day, err := time.Parse("2006-01-02", in.OnDate)
		if err != nil {
			bad(w, 400, "invalid", "that is not a date")
			return
		}

		var started time.Time
		var length int
		if err := st.pool.QueryRow(r.Context(),
			`SELECT started_on, length_days FROM crm.programmes WHERE id = $1`,
			in.ProgrammeID).Scan(&started, &length); err != nil {
			bad(w, 404, "not_found", "no programme with that reference")
			return
		}
		if day.Before(started) || day.After(started.AddDate(0, 0, length-1)) {
			bad(w, 400, "out_of_range", "that day is not part of this programme")
			return
		}

		var id string
		if err := st.pool.QueryRow(r.Context(), `
			INSERT INTO crm.programme_notes (programme_id, on_date, body, author, by)
			VALUES ($1, $2, $3, 'practitioner', $4)
			RETURNING id`, in.ProgrammeID, day, body, strings.TrimSpace(in.By)).Scan(&id); err != nil {
			bad(w, 500, "not_saved", "could not save that")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true, "id": id})
	}
}
