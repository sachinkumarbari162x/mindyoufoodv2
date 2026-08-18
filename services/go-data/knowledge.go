// KNOWLEDGE — what the desk says, how people ask, and what it missed
//
//	GET    /crm/knowledge              answers + phrasings + the miss queue
//	PATCH  /crm/knowledge/{intent}     rewrite one answer
//	POST   /crm/phrasings              teach it a way of asking
//	DELETE /crm/phrasings/{id}
//	POST   /crm/unrecognised           record a message it could not place
//	POST   /crm/unrecognised/{id}/done clear it from the queue
//
// The desk reads all of this at boot and caches it; see the note in
// node-bff/rules/knowledge.js about why a stale cache is the right
// failure here.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

/* GET /crm/knowledge?audience=desk|client|all

   TWO BODIES OF ANSWERS IN ONE TABLE, AND THEY MUST NOT MEET.
   `desk` answers a stranger about booking, price and hours.
   `client` answers somebody already on a plan about their plan.

   This query had no audience filter, because it was written when
   every row was a desk row. The moment six client answers were
   loaded, the front desk's boot log went from "11 answers loaded"
   to 17 — and a stranger asking the desk a question could have
   been told to keep their iron tablet two hours from tea.

   THE DEFAULT IS `desk`, NOT `all`, and that is the whole point:
   a caller that forgets to say which it wants gets the narrow set
   rather than everything. The CRM's editor asks for `all`
   explicitly, because editing them is the one job that needs
   both. */
func crmKnowledge(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		audience := r.URL.Query().Get("audience")
		where := ` AND audience = $1`
		args := []any{audience}
		switch audience {
		case "all":
			where = ""
			args = nil
		case "client", "desk":
			// as asked
		default:
			args = []any{"desk"}
		}

		answers := []map[string]any{}
		rows, err := st.pool.Query(ctx, `
			SELECT intent, label, answer, updated_at
			  FROM crm.knowledge WHERE active`+where+` ORDER BY intent`, args...)
		if err != nil {
			bad(w, 500, "query_failed", "could not read the answers")
			return
		}
		for rows.Next() {
			var intent, label, answer string
			var at time.Time
			if err := rows.Scan(&intent, &label, &answer, &at); err != nil {
				rows.Close()
				bad(w, 500, "scan_failed", "could not read an answer")
				return
			}
			answers = append(answers, map[string]any{
				"intent": intent, "label": label, "answer": answer,
				"updatedAt": at.UTC().Format(time.RFC3339),
			})
		}
		rows.Close()

		phrasings := []map[string]any{}
		prows, err := st.pool.Query(ctx, `
			SELECT id, intent, phrase, source FROM crm.phrasings ORDER BY intent, phrase`)
		if err != nil {
			bad(w, 500, "query_failed", "could not read the phrasings")
			return
		}
		for prows.Next() {
			var id, intent, phrase, source string
			if err := prows.Scan(&id, &intent, &phrase, &source); err != nil {
				prows.Close()
				bad(w, 500, "scan_failed", "could not read a phrasing")
				return
			}
			phrasings = append(phrasings, map[string]any{
				"id": id, "intent": intent, "phrase": phrase, "source": source,
			})
		}
		prows.Close()

		// Most-asked first: the thing forty people wanted matters more
		// than the thing one person did.
		missed := []map[string]any{}
		mrows, err := st.pool.Query(ctx, `
			SELECT id, text, seen, last_at
			  FROM crm.unrecognised
			 WHERE NOT resolved
			 ORDER BY seen DESC, last_at DESC
			 LIMIT 100`)
		if err != nil {
			bad(w, 500, "query_failed", "could not read the queue")
			return
		}
		defer mrows.Close()
		for mrows.Next() {
			var id, text string
			var seen int
			var at time.Time
			if err := mrows.Scan(&id, &text, &seen, &at); err != nil {
				bad(w, 500, "scan_failed", "could not read a miss")
				return
			}
			missed = append(missed, map[string]any{
				"id": id, "text": text, "seen": seen,
				"lastAt": at.UTC().Format(time.RFC3339),
			})
		}

		writeJSON(w, 200, map[string]any{
			"answers": answers, "phrasings": phrasings, "unrecognised": missed,
		})
	}
}

// PATCH /crm/knowledge/{intent}
func crmSetAnswer(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Answer string `json:"answer"`
			Label  string `json:"label"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if strings.TrimSpace(in.Answer) == "" {
			// Blanking an answer would make the desk fall silent on that
			// question with no sign anything was wrong. Removing a topic
			// is `active = false`, which is a different, deliberate act.
			bad(w, 400, "invalid", "an answer cannot be empty")
			return
		}

		tag, err := st.pool.Exec(r.Context(), `
			UPDATE crm.knowledge
			   SET answer = $2,
			       label = COALESCE(NULLIF($3, ''), label),
			       updated_at = now()
			 WHERE intent = $1 AND active`,
			r.PathValue("intent"), in.Answer, in.Label)
		if err != nil {
			bad(w, 500, "write_failed", "could not save that answer")
			return
		}
		if tag.RowsAffected() == 0 {
			bad(w, 404, "not_found", "no answer for that topic")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

// POST /crm/phrasings  {intent, phrase}
func crmAddPhrasing(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Intent string `json:"intent"`
			Phrase string `json:"phrase"`
			Source string `json:"source"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		in.Phrase = strings.TrimSpace(strings.ToLower(in.Phrase))
		if in.Intent == "" || len(in.Phrase) < 3 {
			bad(w, 400, "invalid", "a topic and a phrase of at least three characters")
			return
		}
		if in.Source == "" {
			in.Source = "crm"
		}

		var id string
		err := st.pool.QueryRow(r.Context(), `
			INSERT INTO crm.phrasings (intent, phrase, source)
			VALUES ($1, $2, $3)
			ON CONFLICT (lower(phrase)) DO UPDATE SET intent = EXCLUDED.intent
			RETURNING id`, in.Intent, in.Phrase, in.Source).Scan(&id)
		if err != nil {
			bad(w, 500, "write_failed", "could not save that phrasing")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true, "id": id})
	}
}

// DELETE /crm/phrasings/{id}
func crmDropPhrasing(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tag, err := st.pool.Exec(r.Context(),
			`DELETE FROM crm.phrasings WHERE id = $1`, r.PathValue("id"))
		if err != nil {
			bad(w, 500, "write_failed", "could not remove that")
			return
		}
		if tag.RowsAffected() == 0 {
			bad(w, 404, "not_found", "no such phrasing")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

// POST /crm/unrecognised  {text}
//
// Counts repeats rather than adding rows, so the queue ranks by how
// many people asked. Called by the desk on every message it cannot
// place; failure here must never affect the conversation.
func crmMissed(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Text string `json:"text"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		in.Text = strings.TrimSpace(in.Text)
		// Very short fragments ("ok", "hm") are noise, and very long
		// ones are somebody telling their story rather than asking a
		// question the desk was ever meant to answer.
		if len(in.Text) < 4 || len(in.Text) > 300 {
			writeJSON(w, 200, map[string]any{"ok": true, "skipped": true})
			return
		}

		if _, err := st.pool.Exec(r.Context(), `
			INSERT INTO crm.unrecognised (text) VALUES ($1)
			ON CONFLICT (text) DO UPDATE
			   SET seen = crm.unrecognised.seen + 1,
			       last_at = now(),
			       -- Asked again after she cleared it: it is back on the
			       -- queue, because the answer evidently did not land.
			       resolved = false`, in.Text); err != nil {
			bad(w, 500, "write_failed", "could not record that")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

// POST /crm/unrecognised/{id}/done
func crmMissedDone(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tag, err := st.pool.Exec(r.Context(),
			`UPDATE crm.unrecognised SET resolved = true WHERE id = $1`, r.PathValue("id"))
		if err != nil {
			bad(w, 500, "write_failed", "could not update that")
			return
		}
		if tag.RowsAffected() == 0 {
			bad(w, 404, "not_found", "no such entry")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

/*
---- a topic she writes herself --------------------------------

	POST /crm/knowledge  {label, answer}

	The Knowledge page lets her attach a question to a topic the desk
	already answers. This is the other half: a question that fits none
	of them, answered in her own words, becoming a topic of its own.

	Without it the teach queue had exactly two outcomes — bend the
	question into an existing topic, or dismiss it — and "do you do
	keto meal prep" is neither.
*/
func crmAddTopic(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Label  string `json:"label"`
			Answer string `json:"answer"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}

		label := strings.TrimSpace(in.Label)
		answer := strings.TrimSpace(in.Answer)
		if label == "" || answer == "" {
			bad(w, 400, "invalid", "a topic needs a name and an answer")
			return
		}

		/* Fifty words, checked here as well as in the browser.

		   Not an arbitrary cap: this is read aloud by the desk to
		   somebody deciding whether to book, and an answer longer
		   than a short paragraph stops being read. A limit the
		   browser alone enforces is a limit anybody can edit away. */
		if len(strings.Fields(answer)) > 50 {
			bad(w, 400, "too_long", "fifty words at most — the desk reads this out, not a page")
			return
		}

		intent := slugify(label)
		if intent == "" {
			intent = "topic"
		}

		/* A slug that is already taken gets a suffix rather than an
		   error. She named two topics similarly; that is not a
		   mistake she should have to resolve. */
		final := intent
		for n := 2; n < 50; n++ {
			var exists bool
			if err := st.pool.QueryRow(r.Context(),
				`SELECT EXISTS(SELECT 1 FROM crm.knowledge WHERE intent = $1)`, final).Scan(&exists); err != nil {
				break
			}
			if !exists {
				break
			}
			final = fmt.Sprintf("%s-%d", intent, n)
		}

		_, err := st.pool.Exec(r.Context(), `
			INSERT INTO crm.knowledge (intent, label, answer, active)
			VALUES ($1, $2, $3, true)`, final, label, answer)
		if err != nil {
			bad(w, 500, "write_failed", "could not save that topic")
			return
		}

		writeJSON(w, 201, map[string]any{"ok": true, "intent": final, "label": label})
	}
}

/*
A short, stable id from what she typed. Lower case, words joined

	by hyphens, nothing but letters, digits and hyphens — because this
	ends up in a URL and in the phrasings table, and a topic id with a
	question mark in it is a bug waiting for a quiet afternoon.
*/
func slugify(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		default:
			if !dash && b.Len() > 0 {
				b.WriteByte('-')
				dash = true
			}
		}
		if b.Len() >= 40 {
			break
		}
	}
	return strings.Trim(b.String(), "-")
}
