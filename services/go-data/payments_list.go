// Payments, as she needs to see them
//
//	GET /crm/payments   what came in, what is outstanding, what went back
//
// She cannot be asked to take money through a system that will not
// show her what arrived. This is that page's data.
//
// IT JOINS OUT TO THE PERSON AND THE HOUR, because a payments list
// of amounts and reference strings is a bank statement, and she
// does not think in reference strings. Every line answers: who,
// when was their session, what did they pay, and is it settled.
package main

import (
	"net/http"
	"time"
)

type paymentRow struct {
	ID          string     `json:"id"`
	Status      string     `json:"status"`
	AmountMinor int64      `json:"amountMinor"`
	Currency    string     `json:"currency"`
	Provider    string     `json:"provider"`
	Reference   *string    `json:"reference"`
	CreatedAt   time.Time  `json:"createdAt"`
	PaidAt      *time.Time `json:"paidAt"`
	RefundedAt  *time.Time `json:"refundedAt"`

	PersonID   *string    `json:"personId"`
	Name       string     `json:"name"`
	Email      string     `json:"email"`
	SessionAt  *time.Time `json:"sessionAt"`
	Mode       string     `json:"mode"`

	ReceiptNo *string `json:"receiptNo"`
}

// GET /crm/payments
func crmPaymentList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		/* A window, because this list only grows. Ninety days is
		   long enough to answer "did that one ever come through"
		   and short enough that the page stays a page. */
		days := clampInt(r.URL.Query().Get("days"), 90, 1, 365)
		limit := clampInt(r.URL.Query().Get("limit"), 200, 1, 500)

		rows, err := st.pool.Query(r.Context(), `
			SELECT p.id, p.status, p.amount_minor, p.currency, p.provider,
			       p.provider_ref, p.created_at, p.paid_at, p.refunded_at,
			       c.person_id,
			       coalesce(pe.name, '—'), coalesce(pe.email, ''),
			       c.scheduled_start_at, coalesce(c.mode, 'undecided'),
			       i.number
			  FROM crm.payments p
			  LEFT JOIN crm.consultations c ON c.id = p.consultation_id
			  LEFT JOIN crm.people        pe ON pe.id = c.person_id
			  LEFT JOIN crm.invoices       i ON i.payment_id = p.id
			 WHERE p.created_at > now() - make_interval(days => $1)
			 ORDER BY p.created_at DESC
			 LIMIT $2`, days, limit)
		if err != nil {
			bad(w, 500, "read_failed", "could not read the payments")
			return
		}
		defer rows.Close()

		out := []paymentRow{}
		for rows.Next() {
			var p paymentRow
			if err := rows.Scan(&p.ID, &p.Status, &p.AmountMinor, &p.Currency, &p.Provider,
				&p.Reference, &p.CreatedAt, &p.PaidAt, &p.RefundedAt,
				&p.PersonID, &p.Name, &p.Email, &p.SessionAt, &p.Mode,
				&p.ReceiptNo); err != nil {
				continue
			}
			out = append(out, p)
		}

		/* THE TOTALS ARE COUNTED IN POSTGRES, not by adding up the
		   page above. The list is windowed and capped; a total that
		   only counts what fitted on screen is a wrong number that
		   looks right. */
		var (
			paidMonth, paidAll, outstanding, refunded int64
			paidMonthN, outstandingN, refundedN       int
		)
		_ = st.pool.QueryRow(r.Context(), `
			SELECT
			  coalesce(sum(amount_minor) FILTER (
			    WHERE status = 'paid'
			      AND coalesce(paid_at, created_at) >= date_trunc('month', now())), 0),
			  coalesce(sum(amount_minor) FILTER (WHERE status = 'paid'), 0),
			  coalesce(sum(amount_minor) FILTER (WHERE status = 'pending'), 0),
			  coalesce(sum(amount_minor) FILTER (WHERE status = 'refunded'), 0),
			  count(*) FILTER (
			    WHERE status = 'paid'
			      AND coalesce(paid_at, created_at) >= date_trunc('month', now())),
			  count(*) FILTER (WHERE status = 'pending'),
			  count(*) FILTER (WHERE status = 'refunded')
			  FROM crm.payments`).
			Scan(&paidMonth, &paidAll, &outstanding, &refunded,
				&paidMonthN, &outstandingN, &refundedN)

		writeJSON(w, 200, map[string]any{
			"ok":       true,
			"payments": out,
			"totals": map[string]any{
				"paidThisMonthMinor": paidMonth,
				"paidThisMonthCount": paidMonthN,
				"paidAllMinor":       paidAll,
				"outstandingMinor":   outstanding,
				"outstandingCount":   outstandingN,
				"refundedMinor":      refunded,
				"refundedCount":      refundedN,
			},
		})
	}
}
