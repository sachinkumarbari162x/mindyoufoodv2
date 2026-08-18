// Invoices — what the client is handed after paying
//
//	POST /crm/invoices        issue one for a payment (idempotent)
//	GET  /crm/invoices/{id}   read one back
//
// A receipt today. The table has the tax columns already, so the
// day she registers for GST this becomes a tax invoice without
// changing the shape of a document anyone has been issued.
//
// GO DOES NOT DECIDE WHETHER MONEY MOVED. That happens in Node,
// where the gateway secret lives and the signature is checked. By
// the time anything here runs, a payment row already exists.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

/* THE INDIAN FINANCIAL YEAR, which starts in April. A receipt
   issued on 31 March 2027 belongs to 2026-27 and one issued the
   next morning belongs to 2027-28 — get this wrong and the series
   restarts three months early, which is the one thing a numbered
   series may never do. */
func financialYear(t time.Time) string {
	y := t.Year()
	if t.Month() < time.April {
		y--
	}
	return fmt.Sprintf("%d-%02d", y, (y+1)%100)
}

// POST /crm/invoices
func crmInvoiceIssue(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			PaymentID   string `json:"paymentId"`
			Description string `json:"description"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.PaymentID == "" {
			bad(w, 400, "invalid", "a receipt needs a payment")
			return
		}

		var (
			id, number, series string
			seq                int
			issued             bool
		)

		err := pgx.BeginFunc(r.Context(), st.pool, func(tx pgx.Tx) error {
			/* ALREADY ISSUED? Then this is the second report of the
			   same payment — the webhook arriving after the browser,
			   or a retry. Hand back the document that exists rather
			   than minting a second one, and do not burn a number
			   doing it. */
			err := tx.QueryRow(r.Context(), `
				SELECT id, number, series, seq FROM crm.invoices
				 WHERE payment_id = $1`, in.PaymentID).Scan(&id, &number, &series, &seq)
			if err == nil {
				return nil
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}

			/* Everything the document says, read once, here, and
			   then frozen into it. */
			var (
				consultationID, personID   *string
				name, email, currency      string
				amountMinor                int64
				startAt                    *time.Time
			)
			if err := tx.QueryRow(r.Context(), `
				SELECT p.consultation_id, c.person_id,
				       coalesce(pe.name, 'the client'),
				       coalesce(pe.email, ''),
				       p.currency, p.amount_minor, c.scheduled_start_at
				  FROM crm.payments p
				  LEFT JOIN crm.consultations c ON c.id = p.consultation_id
				  LEFT JOIN crm.people        pe ON pe.id = c.person_id
				 WHERE p.id = $1`, in.PaymentID).
				Scan(&consultationID, &personID, &name, &email,
					&currency, &amountMinor, &startAt); err != nil {
				return fmt.Errorf("no such payment: %w", err)
			}

			series = financialYear(time.Now())

			/* The counter row, made on first use. */
			if _, err := tx.Exec(r.Context(), `
				INSERT INTO crm.invoice_counters (series) VALUES ($1)
				ON CONFLICT (series) DO NOTHING`, series); err != nil {
				return err
			}

			/* ONE ROW, ONE LOCK, ONE NUMBER. Two payments landing in
			   the same millisecond queue here rather than racing, and
			   the series moves by exactly one per document.

			   Inside the same transaction as the insert below, which
			   is what keeps it gapless: if this transaction rolls
			   back the number goes back with it. */
			if err := tx.QueryRow(r.Context(), `
				UPDATE crm.invoice_counters
				   SET next_seq = next_seq + 1
				 WHERE series = $1
				RETURNING next_seq - 1`, series).Scan(&seq); err != nil {
				return err
			}

			number = fmt.Sprintf("MYF/%s/%04d", series, seq)

			desc := in.Description
			if desc == "" {
				desc = "Consultation"
				if startAt != nil {
					desc = "Consultation on " + startAt.Format("2 January 2006")
				}
			}

			if err := tx.QueryRow(r.Context(), `
				INSERT INTO crm.invoices
				  (payment_id, consultation_id, person_id, kind, series, seq, number,
				   issued_to_name, issued_to_email, description, currency, amount_minor)
				VALUES ($1, $2, $3, 'receipt', $4, $5, $6, $7, $8, $9, $10, $11)
				RETURNING id`,
				in.PaymentID, consultationID, personID, series, seq, number,
				name, email, desc, currency, amountMinor).Scan(&id); err != nil {
				return err
			}
			issued = true
			return nil
		})

		if err != nil {
			bad(w, 400, "not_issued", "could not issue a receipt for that payment")
			return
		}

		writeJSON(w, 201, map[string]any{
			"ok": true, "id": id, "number": number,
			"series": series, "seq": seq,
			"alreadyIssued": !issued,
		})
	}
}

// GET /crm/invoices/{id}
func crmInvoiceGet(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var out struct {
			ID          string    `json:"id"`
			Number      string    `json:"number"`
			Kind        string    `json:"kind"`
			Name        string    `json:"name"`
			Email       string    `json:"email"`
			Description string    `json:"description"`
			Currency    string    `json:"currency"`
			AmountMinor int64     `json:"amountMinor"`
			IssuedAt    time.Time `json:"issuedAt"`
			Reference   *string   `json:"reference"`
		}
		err := st.pool.QueryRow(r.Context(), `
			SELECT i.id, i.number, i.kind, i.issued_to_name, i.issued_to_email,
			       i.description, i.currency, i.amount_minor, i.issued_at,
			       p.provider_ref
			  FROM crm.invoices i
			  JOIN crm.payments p ON p.id = i.payment_id
			 WHERE i.id = $1`, r.PathValue("id")).
			Scan(&out.ID, &out.Number, &out.Kind, &out.Name, &out.Email,
				&out.Description, &out.Currency, &out.AmountMinor, &out.IssuedAt,
				&out.Reference)
		if err != nil {
			bad(w, 404, "not_found", "no such receipt")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "receipt": out})
	}
}
