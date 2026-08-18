// Plan links — the opaque token a client reads their plan through
//
//	POST /crm/plans/{id}/link   mint one (or return the existing)
//	GET  /plan-link/{token}     resolve it — PUBLIC
//
// THE RESOLVE ROUTE IS UNAUTHENTICATED AND RETURNS CLINICAL TEXT,
// which makes it the most carefully drawn thing in this file. It is
// reached from an email or a WhatsApp message by somebody who has
// proved nothing, so it answers with the plan and the least
// possible amount of anything else.
//
// WHAT IT DELIBERATELY DOES NOT RETURN: the private note, the
// person's id, their email, their phone, their conditions, their
// assessment, the consultation, or any other plan of theirs. The
// private note is not filtered out downstream — it is never
// selected, so no later change to a handler can leak it by
// forgetting to strip a field.
package main

import (
	"encoding/json"
	"net/http"
	"time"
)

/* How long a plan link lives. A programme runs for weeks and gets
   re-read on a Tuesday in week three, so hours are useless here —
   but a token sitting in a two-year-old chat thread should be
   worthless, so it is not forever either. */
const planLinkLives = 180 * 24 * time.Hour

// POST /crm/plans/{id}/link
func crmPlanLinkMint(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")

		/* Only an issued plan gets a door. A draft is a document she
		   is still writing, and handing somebody a link to it means
		   they read half a plan and start following it. */
		var personID string
		var planNo int
		var status string
		if err := st.pool.QueryRow(r.Context(), `
			SELECT person_id, plan_no, status FROM crm.plans WHERE id = $1`, id).
			Scan(&personID, &planNo, &status); err != nil {
			bad(w, 404, "not_found", "no plan with that reference")
			return
		}
		if status != "issued" {
			bad(w, 409, "not_issued", "issue the plan first — a draft has no link")
			return
		}

		token, err := newToken()
		if err != nil {
			bad(w, 500, "no_token", "could not make a link")
			return
		}

		/* MINT-OR-RETURN. The token generated above is discarded on
		   conflict, which is the point: whoever already has the link
		   keeps it, and amending the plan does not change the address
		   they were given. */
		var out string
		var expires time.Time
		err = st.pool.QueryRow(r.Context(), `
			INSERT INTO crm.plan_links (token, person_id, plan_no, expires_at)
			VALUES ($1, $2, $3, now() + $4::interval)
			ON CONFLICT (person_id, plan_no) DO UPDATE
			   SET expires_at = EXCLUDED.expires_at
			RETURNING token, expires_at`,
			token, personID, planNo, planLinkLives.String()).Scan(&out, &expires)
		if err != nil {
			bad(w, 500, "no_link", "could not make a link")
			return
		}

		writeJSON(w, 200, map[string]any{
			"ok":        true,
			"token":     out,
			"expiresAt": expires.Format(time.RFC3339),
		})
	}
}

/* GET /plan-link/{token} — PUBLIC.

   Resolves to the LATEST ISSUED version, not the version current
   when the link was minted. That is the entire reason the link
   points at a plan rather than a row: she corrects a plan precisely
   because the old text was wrong, and a client still reading it is
   the thing the correction was for.

   ONE ANSWER FOR EVERY KIND OF FAILURE. Unknown token, expired
   token, plan withdrawn, person erased — all 404 with the same
   body. Telling them apart would let somebody holding a stale token
   learn that it was once real, which is a fact about a named
   person's care. */
func planLinkResolve(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("token")
		if len(token) < 16 || len(token) > 64 {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}

		ctx := r.Context()

		var personID, firstName string
		var planNo int
		if err := st.pool.QueryRow(ctx, `
			SELECT l.person_id, split_part(btrim(p.name), ' ', 1), l.plan_no
			  FROM crm.plan_links l
			  JOIN crm.people p ON p.id = l.person_id
			 WHERE l.token = $1 AND l.expires_at > now()`, token).
			Scan(&personID, &firstName, &planNo); err != nil {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}

		/* The columns are listed one by one on purpose. A SELECT *
		   here would put private_note on the wire the moment anybody
		   added a field to the struct, and this is the response that
		   goes to somebody who has proved nothing. */
		var ref, body string
		var targets json.RawMessage
		var issuedAt time.Time
		if err := st.pool.QueryRow(ctx, `
			SELECT ref, body, targets, issued_at
			  FROM crm.plans
			 WHERE person_id = $1 AND plan_no = $2 AND status = 'issued'
			 ORDER BY amendment DESC
			 LIMIT 1`, personID, planNo).
			Scan(&ref, &body, &targets, &issuedAt); err != nil {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}

		/* Counted after the answer is known to be good, so a probe
		   against a dead token does not move a number she reads as
		   "they opened it". Best effort — a failed count must never
		   cost somebody their plan. */
		_, _ = st.pool.Exec(ctx, `
			UPDATE crm.plan_links
			   SET opened_at = COALESCE(opened_at, now()), open_count = open_count + 1
			 WHERE token = $1`, token)

		writeJSON(w, 200, map[string]any{
			"ok":        true,
			"firstName": firstName,
			"ref":       ref,
			"body":      body,
			"targets":   targets,
			"issuedAt":  issuedAt.Format(time.RFC3339),
		})
	}
}
