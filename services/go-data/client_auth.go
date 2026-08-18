/* ============================================================
   CLIENT AUTH — who is looking at the account panel
   ------------------------------------------------------------
   The programme link (programmes.go) identifies a COURSE OF
   TREATMENT: hold the token, see the plan. That was right for a
   plan the client works through and wrong for an account, which
   outlives any one programme and holds receipts, documents and
   a history. So this file is a second, narrower thing: it
   identifies a PERSON.

   The difference matters at the edges. When Rajat's sixty days
   run out his programme is over and his account is not — he
   still has his records, his receipts and his history, and he
   can still ask to be seen again. Entitlement is answered by
   programmes.status and by the dates on it; identity is
   answered here. Neither table knows about the other, which is
   what stops "your plan ended" from becoming "who are you".

   HOW SOMEONE SIGNS IN
   A six-digit code to the address already on their record. No
   password, because a password is a thing to forget, to reuse
   from somewhere worse, and to have to store. The address is
   not chosen at sign-in — it must already be a client of hers,
   which means an attacker cannot enrol themselves.

   WHAT THIS FILE WILL NOT DO
     · It will not say whether an address is a client. Every
       answer to "send me a code" is the same answer.
     · It will not hold a code. Only a scrypt hash of one, and
       the hashing happens in the BFF for the same reason staff
       passwords do — one place owns the crypto.
     · It will not let a code be guessed. Six digits is a
       million, which is a lot for a person and nothing for a
       script, so five wrong attempts burn the code entirely.
     · It will not hand out an id. The session token is opaque
       and the person id never leaves this service in a reply
       the browser can read — see client_account.go.

   ROUTES (service-token protected, BFF only)
     POST /client/codes            store a hashed code for an address
     GET  /client/codes            the live code for an address
     POST /client/codes/{id}/miss  a wrong guess
     POST /client/codes/{id}/use   right guess: consume it, mint a session
     GET  /client/session          resolve a session token
     POST /client/session/revoke   sign out
   ============================================================ */
package main

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

/* How long a code is worth typing. Long enough to walk to the
   other room for the phone, short enough that a code left in an
   inbox is not a key to the account a week later. */
const clientCodeLives = 15 * time.Minute

/* Five wrong guesses and the code is dead — not the account.
   Locking the account would hand anyone who knows an address a
   way to lock its owner out of it. */
const clientCodeTries = 5

/* A signed-in client stays signed in for thirty days. This is a
   health record, not a bank: the cost of asking her to type a
   code every week is that she stops opening the app, and a plan
   nobody opens is worth nothing. Every session is revocable and
   every one is written down. */
const clientSessionLives = 30 * 24 * time.Hour

/* ---- minting -------------------------------------------------- */

/* POST /client/codes  {email, hash, sentTo, channel}

   The BFF has already made a six-digit code and hashed it. This
   stores the hash against whoever owns that address, and says
   whether there was anybody — which is for the BFF's eyes only,
   because it is what decides whether an email is worth sending.
   The BFF's own answer to the browser is the same either way. */
func clientCodeStore(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Email   string `json:"email"`
			Hash    string `json:"hash"`
			Channel string `json:"channel"`
		}
		if err := decode(r, &in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		email := strings.TrimSpace(in.Email)
		if email == "" || in.Hash == "" {
			bad(w, 400, "missing", "an address and a hash")
			return
		}
		channel := in.Channel
		if channel != "whatsapp" {
			channel = "email"
		}

		ctx := r.Context()
		var personID string
		err := st.pool.QueryRow(ctx,
			`SELECT id FROM crm.people WHERE lower(email) = lower($1)`, email).Scan(&personID)
		if errors.Is(err, pgx.ErrNoRows) {
			// Not an error. Nobody by that address asked for a code,
			// and the caller is told plainly so it can decline to
			// send anything — silence here would be a bug, not a
			// secret.
			writeJSON(w, 200, map[string]any{"ok": true, "found": false})
			return
		}
		if err != nil {
			bad(w, 500, "read_failed", "could not check that")
			return
		}

		/* ONE LIVE CODE PER PERSON, enforced by a partial unique
		   index (client_codes_one_live). Asking again replaces the
		   last one rather than adding a second: two valid codes
		   doubles what a guess is worth, and the older one is the
		   one an attacker is likelier to have. */
		if _, err := st.pool.Exec(ctx,
			`DELETE FROM crm.client_codes WHERE person_id = $1 AND used_at IS NULL`,
			personID); err != nil {
			bad(w, 500, "not_saved", "could not do that")
			return
		}

		var id string
		if err := st.pool.QueryRow(ctx, `
			INSERT INTO crm.client_codes (person_id, code_hash, sent_to, channel, expires_at)
			VALUES ($1, $2, $3, $4, now() + $5::interval)
			RETURNING id`,
			personID, in.Hash, email, channel, clientCodeLives.String()).Scan(&id); err != nil {
			bad(w, 500, "not_saved", "could not do that")
			return
		}

		var name string
		_ = st.pool.QueryRow(ctx,
			`SELECT split_part(btrim(name), ' ', 1) FROM crm.people WHERE id = $1`,
			personID).Scan(&name)

		writeJSON(w, 201, map[string]any{
			"ok": true, "found": true, "codeId": id,
			"firstName": name, "expiresInMinutes": int(clientCodeLives.Minutes()),
		})
	}
}

/* GET /client/codes?email=

   Hands back the stored hash so the BFF can verify a typed code
   against it. The same shape as staff login, for the same
   reason: one module owns scrypt, and it is not this one. */
func clientCodeGet(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		email := strings.TrimSpace(r.URL.Query().Get("email"))
		if email == "" {
			bad(w, 400, "missing", "an address")
			return
		}

		var id, personID, hash string
		var attempts int
		var expires time.Time
		err := st.pool.QueryRow(r.Context(), `
			SELECT c.id, c.person_id, c.code_hash, c.attempts, c.expires_at
			  FROM crm.client_codes c
			  JOIN crm.people p ON p.id = c.person_id
			 WHERE lower(p.email) = lower($1)
			   AND c.used_at IS NULL
			   AND c.expires_at > now()
			 ORDER BY c.created_at DESC LIMIT 1`, email).
			Scan(&id, &personID, &hash, &attempts, &expires)
		if err != nil {
			// Expired, used, never issued, or no such person — one
			// answer for all four.
			writeJSON(w, 200, map[string]any{"ok": true, "code": nil})
			return
		}
		if attempts >= clientCodeTries {
			writeJSON(w, 200, map[string]any{"ok": true, "code": nil})
			return
		}

		writeJSON(w, 200, map[string]any{"ok": true, "code": map[string]any{
			"id": id, "personId": personID, "hash": hash,
			"attempts": attempts, "triesLeft": clientCodeTries - attempts,
			"expiresAt": expires.UTC().Format(time.RFC3339),
		}})
	}
}

/* POST /client/codes/{id}/miss — a wrong guess, counted.

   The count is in Postgres rather than in the BFF's memory
   because a restart must not hand an attacker a fresh five. */
func clientCodeMiss(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var attempts int
		if err := st.pool.QueryRow(r.Context(), `
			UPDATE crm.client_codes SET attempts = attempts + 1
			 WHERE id = $1 AND used_at IS NULL
			 RETURNING attempts`, r.PathValue("id")).Scan(&attempts); err != nil {
			writeJSON(w, 200, map[string]any{"ok": true, "triesLeft": 0})
			return
		}
		left := max(clientCodeTries-attempts, 0)
		if left == 0 {
			// Burnt. Removing it rather than leaving it to expire
			// means the next request gets a clean "ask for another"
			// instead of five more minutes of nothing working.
			_, _ = st.pool.Exec(r.Context(),
				`DELETE FROM crm.client_codes WHERE id = $1`, r.PathValue("id"))
		}
		writeJSON(w, 200, map[string]any{"ok": true, "triesLeft": left})
	}
}

/* POST /client/codes/{id}/use  {userAgent, ipHash}

   The right code. Consuming it and minting the session are one
   transaction: a session that exists against a code still marked
   unused is a code that can be spent twice.

   The token is 32 bytes of crypto/rand from newToken(). It is
   stored as the primary key of crm.client_sessions in the clear,
   which is a deliberate and bounded exception — it is not a
   password, it cannot be reused anywhere else, it expires, and
   she can revoke it. Hashing it would cost a lookup on every
   request and buy protection only against an attacker who
   already has the whole database. */
func clientCodeUse(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			UserAgent string `json:"userAgent"`
			IPHash    string `json:"ipHash"`
		}
		_ = decode(r, &in)

		token, err := newToken()
		if err != nil {
			bad(w, 500, "no_token", "could not sign you in")
			return
		}

		ctx := r.Context()
		tx, err := st.pool.Begin(ctx)
		if err != nil {
			bad(w, 500, "not_saved", "could not sign you in")
			return
		}
		defer tx.Rollback(ctx)

		var personID string
		if err := tx.QueryRow(ctx, `
			UPDATE crm.client_codes SET used_at = now()
			 WHERE id = $1 AND used_at IS NULL AND expires_at > now()
			 RETURNING person_id`, r.PathValue("id")).Scan(&personID); err != nil {
			bad(w, 410, "code_gone", "that code has already been used")
			return
		}

		ua := in.UserAgent
		if len(ua) > 300 {
			ua = ua[:300]
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO crm.client_sessions (token, person_id, expires_at, user_agent, ip_hash, last_seen_at)
			VALUES ($1, $2, now() + $3::interval, $4, $5, now())`,
			token, personID, clientSessionLives.String(), ua, in.IPHash); err != nil {
			bad(w, 500, "not_saved", "could not sign you in")
			return
		}
		if err := tx.Commit(ctx); err != nil {
			bad(w, 500, "not_saved", "could not sign you in")
			return
		}

		var name, email string
		_ = st.pool.QueryRow(ctx,
			`SELECT name, email FROM crm.people WHERE id = $1`, personID).Scan(&name, &email)

		writeJSON(w, 201, map[string]any{
			"ok": true, "token": token,
			"expiresAt": time.Now().Add(clientSessionLives).UTC().Format(time.RFC3339),
			"person": map[string]any{
				"name": name, "firstName": firstWord(name), "email": email,
			},
		})
	}
}

/* ---- resolving ------------------------------------------------ */

/* Session token to person id, or "" and a reason to stop.

   Runs on the PRACTITIONER pool, which is the whole point of the
   comment on asClient: working out who is asking necessarily
   reaches further than what the answer is then allowed to see.
   Nothing downstream of this reads a row outside asClient. */
func (s *Store) clientFor(r *http.Request, token string) (string, bool) {
	personID, _, ok := s.clientSession(r, token)
	return personID, ok
}

/* Who, and HOW THEY GOT IN. A session opened by a token in a URL
   is narrower than one opened by a code sent to their address —
   see migration 0008 for why that distinction is not optional.

   The scope comes off the session row, never off the request. */
func (s *Store) clientSession(r *http.Request, token string) (string, string, bool) {
	if len(token) < 16 || len(token) > 128 {
		return "", "", false
	}
	var personID, scope string
	err := s.pool.QueryRow(r.Context(), `
		UPDATE crm.client_sessions
		   SET last_seen_at = now()
		 WHERE token = $1 AND revoked_at IS NULL AND expires_at > now()
		 RETURNING person_id, scope`, token).Scan(&personID, &scope)
	if err != nil {
		return "", "", false
	}
	return personID, scope, true
}

/* POST /client/session/from-token  {token, userAgent, ipHash}

   THE LINK IN THEIR POCKET, TURNED INTO A SESSION. /me/<token>
   used to open a separate app; it now opens the account panel, so
   the token has to become something the panel understands.

   WHAT IT DELIBERATELY DOES NOT MINT is a full session. A token
   lives in a URL — forwarded, screenshotted, read aloud — and
   somebody who finds one should be able to see the plan and
   nothing else. The narrow scope is written onto the session row
   here and enforced in client_account.go, so no caller can widen
   it by asking nicely.

   No code, no typing, no password. That was the point of the link
   and it survives. */
func clientSessionFromToken(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Token     string `json:"token"`
			UserAgent string `json:"userAgent"`
			IPHash    string `json:"ipHash"`
		}
		if err := decode(r, &in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}

		/* The same resolution the programme app always used, with
		   the same single refusal for every failure — unknown,
		   revoked, ended, expired — because telling them apart
		   leaks whether a token was ever real. */
		progID, personID, _, ok := st.programmeFor(r, in.Token)
		if !ok {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}

		sessionToken, err := newToken()
		if err != nil {
			bad(w, 500, "no_token", "could not open that")
			return
		}

		ua := in.UserAgent
		if len(ua) > 300 {
			ua = ua[:300]
		}
		if _, err := st.pool.Exec(r.Context(), `
			INSERT INTO crm.client_sessions
			  (token, person_id, expires_at, user_agent, ip_hash, last_seen_at, scope, via_programme)
			VALUES ($1, $2, now() + $3::interval, $4, $5, now(), 'programme', $6)`,
			sessionToken, personID, clientSessionLives.String(), ua, in.IPHash, progID); err != nil {
			bad(w, 500, "not_saved", "could not open that")
			return
		}

		var name string
		_ = st.pool.QueryRow(r.Context(),
			`SELECT name FROM crm.people WHERE id = $1`, personID).Scan(&name)

		writeJSON(w, 201, map[string]any{
			"ok": true, "token": sessionToken, "scope": "programme",
			"person": map[string]any{"firstName": firstWord(name)},
		})
	}
}

/* The token arrives in a header, never in the path or the query.
   A path carrying a credential ends up in an access log, in a
   Referer, and in somebody's browser history. */
func clientToken(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("X-Client-Session"))
}

// GET /client/session — is this token still good, and whose is it?
func clientSessionResolve(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		personID, ok := st.clientFor(r, clientToken(r))
		if !ok {
			bad(w, 401, "no_session", "please sign in again")
			return
		}
		var name, email string
		_ = st.pool.QueryRow(r.Context(),
			`SELECT name, email FROM crm.people WHERE id = $1`, personID).Scan(&name, &email)
		writeJSON(w, 200, map[string]any{"ok": true, "person": map[string]any{
			"name": name, "firstName": firstWord(name), "email": email,
		}})
	}
}

/* POST /client/session/revoke — signing out.

   Revoked rather than deleted. The row is the record that a
   device was signed in and when it stopped being; deleting it
   would leave her unable to answer "was anyone else in my
   account" — which is the one question a revoke list exists for. */
func clientSessionRevoke(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := clientToken(r)
		if token == "" {
			writeJSON(w, 200, map[string]any{"ok": true})
			return
		}
		_, _ = st.pool.Exec(r.Context(),
			`UPDATE crm.client_sessions SET revoked_at = now()
			  WHERE token = $1 AND revoked_at IS NULL`, token)
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

func firstWord(s string) string {
	f := strings.Fields(strings.TrimSpace(s))
	if len(f) == 0 {
		return ""
	}
	return f[0]
}
