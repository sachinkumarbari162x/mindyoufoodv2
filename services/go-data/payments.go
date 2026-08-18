// Payments — recording what a provider says arrived
//
//	POST /crm/payments   one payment, after its signature verified
//
// Go stores. It does not verify a signature, talk to a gateway, or
// decide whether money moved — that happens in one place, in Node,
// where the secret lives.
package main

import (
	"encoding/json"
	"net/http"
)

// POST /admin/release-holds — run the sweep now
//
// The same work the purge ticker does every PURGE_EVERY, on
// demand. Returns how many hours were given back.
func adminReleaseHolds(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		n, err := st.ReleaseExpiredHolds(r.Context())
		if err != nil {
			bad(w, 500, "release_failed", "could not release expired holds")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "released": n})
	}
}

// POST /crm/payments
func crmPaymentAdd(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ConsultationID string `json:"consultationId"`
			Provider       string `json:"provider"`
			Reference      string `json:"reference"`
			AmountMinor    int64  `json:"amountMinor"`
			Currency       string `json:"currency"`
			Status         string `json:"status"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.ConsultationID == "" || in.AmountMinor <= 0 || in.Currency == "" {
			bad(w, 400, "invalid", "a payment needs a consultation, an amount and a currency")
			return
		}
		if in.Status == "" {
			in.Status = "pending"
		}
		if in.Provider == "" {
			in.Provider = "manual"
		}

		/* IDEMPOTENT ON THE PROVIDER'S REFERENCE, because the same
		   payment arrives twice as a matter of course: the browser
		   reports it when checkout closes, and the webhook reports
		   it again a moment later. Both are meant to — the webhook
		   is the backstop for the browser that never came back.

		   The schema already refuses a duplicate: payments_provider_ref
		   is unique on (provider, provider_ref). What was missing was
		   the handler agreeing that a duplicate is a SUCCESS. Before
		   this it let 23505 fall into the error branch and answered
		   "could not record that payment" — so the webhook would log
		   a failure for a payment that was safely recorded, and a
		   retrying gateway would keep being told no.

		   ON CONFLICT DO NOTHING returns no row, so the SELECT below
		   fetches the one already there. The caller gets the same
		   201 and the same id either way, and cannot tell which of
		   the two arrived first — which is the whole point. */
		var id string
		var inserted bool
		err := st.pool.QueryRow(r.Context(), `
			WITH attempted AS (
			  INSERT INTO crm.payments
			    (consultation_id, currency, amount_minor, provider, provider_ref, status)
			  VALUES ($1, upper($2), $3, $4, NULLIF($5,''), $6)
			  ON CONFLICT (provider, provider_ref)
			    WHERE provider_ref IS NOT NULL
			    DO NOTHING
			  RETURNING id
			)
			SELECT id, true FROM attempted
			UNION ALL
			SELECT id, false FROM crm.payments
			 WHERE provider     = $4
			   AND provider_ref = NULLIF($5,'')
			   AND NOT EXISTS (SELECT 1 FROM attempted)
			LIMIT 1`,
			in.ConsultationID, in.Currency, in.AmountMinor,
			in.Provider, in.Reference, in.Status).Scan(&id, &inserted)
		if err != nil {
			// The status CHECK and the consultation foreign key both
			// live in the schema; a violation here is a caller sending
			// something the practice does not recognise.
			bad(w, 400, "write_failed", "could not record that payment")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true, "id": id, "alreadyRecorded": !inserted})
	}
}
