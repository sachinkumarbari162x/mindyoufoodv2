// Consultation links — an opaque token, and the page behind it
//
//	POST /crm/consultations/{id}/link   mint one (or return the existing)
//	GET  /link/{token}                  resolve it — PUBLIC
//
// THE RESOLVE ROUTE IS THE ONLY UNAUTHENTICATED THING IN THIS
// SERVICE THAT TOUCHES A CONSULTATION. Everything about it is
// written on that basis: it is reached from a WhatsApp message by
// somebody who has proved nothing, so it answers with the least it
// can and never with anything that identifies a person.
package main

import (
	"net/http"
	"time"
)

/* How long a link outlives its appointment.

   Long enough that somebody checking the morning after still sees
   something sensible rather than a dead page; short enough that a
   token in a two-year-old chat log is worthless. */
const linkLivesAfter = 24 * time.Hour

/* And for a booking with no time on it yet — she has not scheduled
   it, so there is nothing to count from. */
const linkLivesUnscheduled = 30 * 24 * time.Hour

// POST /crm/consultations/{id}/link
func crmLinkMint(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")

		token, err := newToken()
		if err != nil {
			bad(w, 500, "no_token", "could not make a link")
			return
		}

		/* MINT-OR-RETURN, in one statement.
		   ON CONFLICT DO UPDATE rather than DO NOTHING, because
		   DO NOTHING returns no row and the caller then has to guess
		   whether it failed or already existed. Updating the expiry
		   also means a rescheduled consultation's link stops dying at
		   the old appointment's deadline.

		   The token minted above is discarded on conflict, which is
		   the point: the client keeps the link they were already
		   given. */
		var out string
		var expires time.Time
		err = st.pool.QueryRow(r.Context(), `
			INSERT INTO crm.consultation_links (token, consultation_id, purpose, expires_at)
			SELECT $2, c.id, 'consultation',
			       COALESCE(c.scheduled_start_at + $3::interval, now() + $4::interval)
			  FROM crm.consultations c
			 WHERE c.id = $1
			ON CONFLICT (consultation_id, purpose) DO UPDATE
			   SET expires_at = EXCLUDED.expires_at
			RETURNING token, expires_at`,
			id, token, linkLivesAfter.String(), linkLivesUnscheduled.String()).
			Scan(&out, &expires)
		if err != nil {
			bad(w, 404, "not_found", "no consultation with that reference")
			return
		}

		writeJSON(w, 200, map[string]any{
			"ok":        true,
			"token":     out,
			"expiresAt": expires.Format(time.RFC3339),
		})
	}
}

/* GET /link/{token} — PUBLIC. Reached from a WhatsApp message.

   WHAT IT DELIBERATELY DOES NOT RETURN: the person's name, their
   email, their phone number, what they are being seen about, or the
   consultation's own id. Whoever holds this token has proved nothing
   — it may have been forwarded, screenshotted, or synced to a family
   tablet — so the answer is the least that still makes the page
   worth opening.

   It says only that a consultation exists, and when. That is enough
   for the page to be useful and useless to anybody else. */
func linkResolve(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("token")

		/* Bounded before it reaches the database. The column is a
		   primary key so a long string would be rejected anyway, but
		   not after being sent over the wire and indexed. */
		if len(token) < 16 || len(token) > 64 {
			writeJSON(w, 404, map[string]any{"ok": false, "reason": "unknown"})
			return
		}

		var startAt *time.Time
		var status, consultationID, firstName string
		var expires time.Time

		/* The read and the open-count in ONE statement, so a page
		   view cannot be recorded for a link that was not actually
		   resolved, and a resolve cannot go uncounted. */
		err := st.pool.QueryRow(r.Context(), `
			WITH opened AS (
			  UPDATE crm.consultation_links
			     SET open_count = open_count + 1,
			         opened_at  = COALESCE(opened_at, now())
			   WHERE token = $1 AND expires_at > now()
			  RETURNING consultation_id, expires_at
			)
			SELECT c.scheduled_start_at, c.status, o.expires_at, c.id,
			       COALESCE(split_part(btrim(p.name), ' ', 1), '')
			  FROM opened o
			  JOIN crm.consultations c ON c.id = o.consultation_id
			  LEFT JOIN crm.people p ON p.id = c.person_id`,
			token).Scan(&startAt, &status, &expires, &consultationID, &firstName)

		if err != nil {
			/* One answer for "never existed" and for "expired", and it
			   is not an accident. Telling them apart would let somebody
			   holding a stale token learn that it was once real, which
			   is a fact about a client's appointment. The page says
			   "this link is no longer active", which covers both
			   honestly without distinguishing them. */
			writeJSON(w, 404, map[string]any{"ok": false, "reason": "unknown"})
			return
		}

		/* consultationId is returned to the BFF and STRIPPED there
		   before anything reaches a browser. The room needs to know
		   which consultation this token is for; the person holding
		   the token does not, and handing them an id they could try
		   elsewhere is exactly the kind of small leak that makes an
		   opaque link pointless. See GET /api/link. */
		/* THE FIRST NAME, AND ONLY THE FIRST.

		   Their own name is not a disclosure to them, and it answers
		   the first question this page gets asked: the link arrived
		   in a message with no account and no password behind it, so
		   "is this mine, or did I open somebody else's" has to be
		   settled before anybody presses Join. The plan link and the
		   programme app both do this already; the consultation link
		   was the one that did not, and it is the one that opens a
		   camera.

		   A surname would identify them to whoever is looking over
		   their shoulder on a train, which the first name alone does
		   not — the same split the other two links make. */
		writeJSON(w, 200, map[string]any{
			"ok":             true,
			"firstName":      firstName,
			"startAt":        ts(startAt),
			"status":         status,
			"expiresAt":      expires.Format(time.RFC3339),
			"consultationId": consultationID,
		})
	}
}
