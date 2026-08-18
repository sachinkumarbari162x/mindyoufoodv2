// What the system sent, and whether it arrived
//
//	POST  /crm/messages         record one before it is attempted
//	PATCH /crm/messages/{id}    the outcome of that attempt
//	GET   /crm/messages         the page
//	GET   /crm/messages/{id}    enough to send it again
//
// THE ROW IS WRITTEN BEFORE THE SEND, NOT AFTER. A message recorded
// only on success is a message that vanishes exactly when it matters
// — the provider times out, nothing is written, and the visitor's
// missing confirmation leaves no trace anywhere. Written first, a
// failure is a row that says so and can be retried.
package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// POST /crm/messages
func crmMessageQueue(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ConsultationID *string `json:"consultationId"`
			PersonID       *string `json:"personId"`
			TemplateID     string  `json:"templateId"`
			Version        int     `json:"templateVersion"`
			Recipient      string  `json:"recipient"`
			Subject        string  `json:"subject"`
			Channel        string  `json:"channel"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.TemplateID == "" || in.Recipient == "" {
			bad(w, 400, "invalid", "a message needs a template and a recipient")
			return
		}
		if in.Channel == "" {
			in.Channel = "email"
		}
		if in.Version == 0 {
			in.Version = 1
		}

		var id string
		err := st.pool.QueryRow(r.Context(), `
			INSERT INTO crm.messages
			  (consultation_id, person_id, channel, template_id, template_version,
			   recipient, subject, status, attempts)
			VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', 0)
			RETURNING id`,
			in.ConsultationID, in.PersonID, in.Channel, in.TemplateID, in.Version,
			in.Recipient, in.Subject).Scan(&id)

		if err != nil {
			/* 23505 is the one-of-each-kind-per-booking index doing its
			   job: this exact message has already been queued or sent
			   for this consultation ON THIS CHANNEL. The channel is
				   part of the key because the email and the WhatsApp
				   confirmation share a template id, and keying on the
				   template alone let the email silently swallow the
				   WhatsApp message (see 0016).

				   It is not an error worth failing
			   on — it is the answer "already handled" — so the existing
			   row comes back and the caller sends nothing.

			   This is what makes a double-clicked Accept harmless. */
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				var existing, status string
				_ = st.pool.QueryRow(r.Context(), `
					SELECT id, status FROM crm.messages
					 WHERE consultation_id = $1 AND template_id = $2 AND channel = $3`,
					in.ConsultationID, in.TemplateID, in.Channel).Scan(&existing, &status)
				writeJSON(w, 200, map[string]any{
					"ok": true, "id": existing, "status": status, "duplicate": true,
				})
				return
			}
			bad(w, 500, "not_queued", "could not record that message")
			return
		}

		writeJSON(w, 201, map[string]any{"ok": true, "id": id, "duplicate": false})
	}
}

// PATCH /crm/messages/{id} — how the attempt went
func crmMessageResult(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Status     string `json:"status"`
			Provider   string `json:"provider"`
			ProviderID string `json:"providerId"`
			Error      string `json:"error"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.Status != "sent" && in.Status != "failed" {
			bad(w, 400, "invalid", "status must be sent or failed")
			return
		}

		/* attempts climbs on every attempt, and sent_at is only set
		   when it actually went. A row that says 'sent' with three
		   attempts behind it is the truth about a flaky provider. */
		ct, err := st.pool.Exec(r.Context(), `
			UPDATE crm.messages
			   SET status      = $2,
			       provider    = NULLIF($3,''),
			       provider_id = NULLIF($4,''),
			       error       = NULLIF($5,''),
			       attempts    = attempts + 1,
			       sent_at     = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
			 WHERE id = $1`,
			r.PathValue("id"), in.Status, in.Provider, in.ProviderID, in.Error)
		if err != nil {
			bad(w, 500, "not_saved", "could not record that outcome")
			return
		}
		if ct.RowsAffected() == 0 {
			bad(w, 404, "not_found", "no message with that reference")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

// GET /crm/messages?limit=&status=
func crmMessageList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := 100
		if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 500 {
			limit = n
		}

		rows, err := st.pool.Query(r.Context(), `
			SELECT m.id, m.channel, m.template_id, m.template_version,
			       m.recipient, m.subject, m.status,
			       COALESCE(m.provider,''), COALESCE(m.provider_id,''),
			       COALESCE(m.error,''), m.attempts, m.created_at, m.sent_at,
			       COALESCE(p.name,'')
			  FROM crm.messages m
			  LEFT JOIN crm.people p ON p.id = m.person_id
			 WHERE ($1 = '' OR m.status = $1)
			 ORDER BY m.created_at DESC
			 LIMIT $2`,
			r.URL.Query().Get("status"), limit)
		if err != nil {
			bad(w, 500, "read_failed", "could not read the messages")
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var id, channel, tpl, recipient, subject, status string
			var provider, providerID, errText, name string
			var version, attempts int
			var createdAt time.Time
			var sentAt *time.Time
			if err := rows.Scan(&id, &channel, &tpl, &version, &recipient, &subject,
				&status, &provider, &providerID, &errText, &attempts,
				&createdAt, &sentAt, &name); err != nil {
				continue
			}
			out = append(out, map[string]any{
				"id": id, "channel": channel, "kind": tpl,
				"templateId": tpl, "templateVersion": version,
				"recipient": recipient, "subject": subject, "status": status,
				"provider": provider, "providerId": providerID, "error": errText,
				"attempts": attempts, "name": name,
				"at":     createdAt.Format(time.RFC3339),
				"sentAt": ts(sentAt),
			})
		}
		writeJSON(w, 200, map[string]any{"ok": true, "messages": out})
	}
}

/* GET /crm/messages/{id} — everything needed to send it again.

   The body is deliberately not stored, so a retry re-renders from the
   consultation as it stands NOW. That is the useful behaviour: a
   confirmation retried after she fixed a typo in the template goes
   out corrected, and one retried after a reschedule carries the new
   time rather than the old one. */
func crmMessageOne(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var id, tpl, recipient, status string
		var consultationID, personID *string
		var version int

		err := st.pool.QueryRow(r.Context(), `
			SELECT id, consultation_id, person_id, template_id, template_version,
			       recipient, status
			  FROM crm.messages WHERE id = $1`, r.PathValue("id")).
			Scan(&id, &consultationID, &personID, &tpl, &version, &recipient, &status)
		if err != nil {
			bad(w, 404, "not_found", "no message with that reference")
			return
		}

		writeJSON(w, 200, map[string]any{
			"ok": true,
			"message": map[string]any{
				"id": id, "consultationId": consultationID, "personId": personID,
				"templateId": tpl, "templateVersion": version,
				"recipient": recipient, "status": status,
			},
		})
	}
}

/* GET /crm/people/exists?email= — is this address already on file?

   ANSWERS A BOOLEAN AND NOTHING ELSE. No name, no id, no dates, no
   count of visits. The desk needs to know whether to accept a
   booking; anything more would be a description of a client handed
   to whoever typed the address.

   THIS IS AN ORACLE, and it is worth being honest about in the code
   that provides it: a stranger who can call this can test whether a
   given person is a client of a dietitian. The desk rate-limits it
   and only asks after a full form submission, so it cannot be swept
   cheaply — but the leak is real and it is the price of the rule
   that returning clients are asked to email instead. */
func crmPersonExists(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		email := strings.TrimSpace(r.URL.Query().Get("email"))
		if email == "" {
			bad(w, 400, "invalid", "an email is needed")
			return
		}

		var exists bool
		// lower() on both sides, matching the unique index that makes
		// email the identity in crm.people.
		err := st.pool.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM crm.people WHERE lower(email) = lower($1))`,
			email).Scan(&exists)
		if err != nil {
			bad(w, 500, "read_failed", "could not check that")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "exists": exists})
	}
}

/* GET /crm/consultations/{id} — one booking, everything an email
   needs to be written about it.

   The list endpoint takes a window (held, today, upcoming) and none
   of those is "this one". Rendering a confirmation by fetching a
   window and searching it would work until the booking she just
   accepted fell outside the window — which is precisely when a
   confirmation is being sent. */
func crmConsultationOne(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var c consultation
		var start, hold *time.Time

		err := st.pool.QueryRow(r.Context(), `
			SELECT c.id, c.person_id, p.name, p.email, p.phone, p.country_iso2,
			       c.issue, c.mode, c.status, c.scheduled_start_at, c.hold_expires_at
			  FROM crm.consultations c
			  JOIN crm.people p ON p.id = c.person_id
			 WHERE c.id = $1`, r.PathValue("id")).
			Scan(&c.ID, &c.PersonID, &c.Name, &c.Email, &c.Phone, &c.Country,
				&c.Issue, &c.Mode, &c.Status, &start, &hold)
		if err != nil {
			bad(w, 404, "not_found", "no consultation with that reference")
			return
		}
		c.StartAt, c.HoldExpiresAt = ts(start), ts(hold)

		writeJSON(w, 200, map[string]any{"ok": true, "consultation": c})
	}
}
