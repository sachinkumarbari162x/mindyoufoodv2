// Checkout — the hour is reserved while somebody is at the till
//
//	POST /crm/consultations/{id}/checkout   mint a checkout link
//	GET  /checkout/{token}                  resolve it — PUBLIC
//	POST /checkout/{token}/paid             the hour is theirs
//
// THE SHAPE OF THE THING. A visitor picks an hour; the hour is
// held for a few minutes with an expiry on it; they pay; the hold
// becomes a confirmed booking. If they wander off the sweeper in
// store.go gives the hour back and the link dies with it.
//
// The token is what the browser carries, never the consultation
// id. The checkout page is reached by somebody who has proved
// nothing beyond typing an email into a form — a page keyed by a
// row id is a page where changing one digit shows a stranger's
// name and the hour they booked.
package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

/* Long enough to find a card and get through a bank's OTP screen,
   short enough that an abandoned tab is not holding her Tuesday
   morning for an afternoon. */
const checkoutWindow = 15 * time.Minute

// POST /crm/consultations/{id}/checkout
func crmCheckoutMint(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		consultationID := r.PathValue("id")

		token, err := newToken()
		if err != nil {
			bad(w, 500, "no_token", "could not start a checkout")
			return
		}

		var (
			outToken  string
			expiresAt time.Time
		)

		err = pgx.BeginFunc(r.Context(), st.pool, func(tx pgx.Tx) error {
			/* The hold and the link expire together, so there is one
			   answer to "how long have I got" rather than two that can
			   disagree. */
			if _, err := tx.Exec(r.Context(), `
				UPDATE crm.consultations
				   SET hold_expires_at = now() + $2::interval,
				       updated_at      = now()
				 WHERE id = $1 AND status = 'held'`,
				consultationID, checkoutWindow.String()); err != nil {
				return err
			}

			/* MINT OR RETURN. A visitor who reloads the form must not
			   accumulate live checkout links to the same hour, and
			   consultation_links_one_per_purpose already refuses a
			   second. Returning the existing one keeps a reload
			   working instead of erroring at them. */
			return tx.QueryRow(r.Context(), `
				INSERT INTO crm.consultation_links (token, consultation_id, purpose, expires_at)
				VALUES ($1, $2, 'checkout', now() + $3::interval)
				ON CONFLICT (consultation_id, purpose) DO UPDATE
				   SET expires_at = EXCLUDED.expires_at
				RETURNING token, expires_at`,
				token, consultationID, checkoutWindow.String()).
				Scan(&outToken, &expiresAt)
		})
		if err != nil {
			bad(w, 400, "no_checkout", "could not start a checkout for that booking")
			return
		}

		writeJSON(w, 201, map[string]any{
			"ok": true, "token": outToken, "expiresAt": expiresAt,
			"secondsLeft": int(time.Until(expiresAt).Seconds()),
		})
	}
}

/* POST /checkout/{token}/resume — PUBLIC
 *
 * PICKING UP A CHECKOUT THAT LAPSED.
 *
 * Somebody reserved an hour, went to find their card, and the
 * fifteen minutes ran out. The sweeper gave the hour back, which
 * is right — but the person is still here, still wants it, and
 * until now their only option was to start again from the front
 * desk and hope the same hour was still free.
 *
 * So: if nobody else has taken it, take it again. The partial
 * unique index is what decides — this does not check whether the
 * slot looks free and then write, it simply writes and lets the
 * database refuse. Between those two there is a gap somebody else
 * books in.
 *
 * If it HAS gone, that is an honest no, and the answer says so
 * differently from "no such token" — because here the visitor
 * deserves to know their hour went rather than that their link is
 * broken.
 */
func checkoutResume(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("token")
		if len(token) < 16 || len(token) > 64 {
			bad(w, 404, "unknown", "that checkout is no longer open")
			return
		}

		var (
			expiresAt time.Time
			taken     bool
		)

		err := pgx.BeginFunc(r.Context(), st.pool, func(tx pgx.Tx) error {
			var consultationID, status string
			var startAt *time.Time

			/* The link is looked up WITHOUT the expiry filter that
			   checkoutFor applies — a lapsed link is exactly what
			   this route is for. */
			if err := tx.QueryRow(r.Context(), `
				SELECT c.id, c.status, c.scheduled_start_at
				  FROM crm.consultation_links l
				  JOIN crm.consultations c ON c.id = l.consultation_id
				 WHERE l.token = $1 AND l.purpose = 'checkout'
				 FOR UPDATE OF c`, token).Scan(&consultationID, &status, &startAt); err != nil {
				return err
			}

			if startAt == nil {
				return errors.New("no hour to resume")
			}
			/* Already paid for. Not an error — the browser and the
			   webhook both come here eventually. */
			if status == "confirmed" {
				return errors.New("already confirmed")
			}

			/* BACK TO HELD, IF THE HOUR IS STILL FREE. The WHERE
			   clause guards against resuming something that is not
			   ours to resume; consultations_slot_unique guards
			   against the hour having gone to somebody else, and
			   raises 23505 if it has. */
			if _, err := tx.Exec(r.Context(), `
				UPDATE crm.consultations
				   SET status          = 'held',
				       hold_expires_at = now() + $2::interval,
				       updated_at      = now()
				 WHERE id = $1 AND status IN ('held', 'cancelled')`,
				consultationID, checkoutWindow.String()); err != nil {
				if strings.Contains(err.Error(), "consultations_slot_unique") {
					taken = true
					return errNoResume
				}
				return err
			}

			return tx.QueryRow(r.Context(), `
				UPDATE crm.consultation_links
				   SET expires_at = now() + $2::interval
				 WHERE token = $1 AND purpose = 'checkout'
				RETURNING expires_at`, token, checkoutWindow.String()).Scan(&expiresAt)
		})

		if taken {
			/* A different answer on purpose. "Somebody else has it"
			   is a fact worth telling somebody who was ready to pay
			   for it. */
			bad(w, http.StatusConflict, "hour_taken", "that hour has since been booked")
			return
		}
		if err != nil {
			bad(w, 404, "unknown", "that checkout is no longer open")
			return
		}

		writeJSON(w, 200, map[string]any{
			"ok": true, "expiresAt": expiresAt,
			"secondsLeft": int(time.Until(expiresAt).Seconds()),
		})
	}
}

var errNoResume = errors.New("hour taken")

/* What the checkout page is allowed to know. Deliberately thin:
   the hour, the fee, the first name, and how long is left. Not the
   consultation id, not the person id, not the email, not the
   notes they typed. A page that shows only what it needs cannot
   leak what it does not have. */
type checkoutView struct {
	FirstName   string    `json:"firstName"`
	StartAt     time.Time `json:"startAt"`
	EndAt       time.Time `json:"endAt"`
	Mode        string    `json:"mode"`
	Timezone    string    `json:"timezone"`
	AmountMinor int64     `json:"amountMinor"`
	Currency    string    `json:"currency"`
	ExpiresAt   time.Time `json:"expiresAt"`
	SecondsLeft int       `json:"secondsLeft"`
	Status      string    `json:"status"`
}

// GET /checkout/{token} — PUBLIC
func checkoutResolve(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v, _, ok := st.checkoutFor(r, r.PathValue("token"))
		if !ok {
			/* ONE ANSWER FOR EVERY KIND OF MISS. Unknown token,
			   expired hold, already paid, cancelled — all "unknown".
			   Anything more specific is a way to probe which tokens
			   once existed. */
			bad(w, 404, "unknown", "that checkout is no longer open")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "checkout": v})
	}
}

/* The lookup behind both routes. Returns the view, the
   consultation id (for the caller, never for the browser), and
   whether it is still open for business. */
func (s *Store) checkoutFor(r *http.Request, token string) (checkoutView, string, bool) {
	var v checkoutView
	var consultationID string

	if len(token) < 16 || len(token) > 64 {
		return v, "", false
	}

	err := s.pool.QueryRow(r.Context(), `
		SELECT c.id,
		       split_part(btrim(p.name), ' ', 1),
		       c.scheduled_start_at, c.scheduled_end_at,
		       c.mode, coalesce(c.timezone, ''),
		       coalesce(pr.amount_minor, 0), coalesce(pr.currency, 'INR'),
		       l.expires_at, c.status
		  FROM crm.consultation_links l
		  JOIN crm.consultations c ON c.id = l.consultation_id
		  JOIN crm.people        p ON p.id = c.person_id
		  LEFT JOIN crm.prices  pr ON pr.active
		 WHERE l.token   = $1
		   AND l.purpose = 'checkout'
		   AND l.expires_at > now()
		   AND c.scheduled_start_at IS NOT NULL`,
		token).Scan(&consultationID, &v.FirstName, &v.StartAt, &v.EndAt,
		&v.Mode, &v.Timezone, &v.AmountMinor, &v.Currency, &v.ExpiresAt, &v.Status)
	if err != nil {
		return v, "", false
	}

	/* A CONSULTATION THAT IS NO LONGER HELD IS NOT AT A CHECKOUT.
	   Confirmed means it is already paid for — showing the page
	   again would invite a second payment for the same hour.
	   Cancelled means the sweeper took it back. */
	if v.Status != "held" {
		return v, consultationID, false
	}

	v.SecondsLeft = int(time.Until(v.ExpiresAt).Seconds())
	return v, consultationID, true
}

// POST /checkout/{token}/paid — PUBLIC, but only ever called by the
// BFF after it has verified a signature against the gateway secret.
//
// Go does not decide whether money moved. By the time this runs,
// Node has checked the signature and written the payment row.
func checkoutPaid(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			PaymentID string `json:"paymentId"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in)

		token := r.PathValue("token")
		var consultationID string

		err := pgx.BeginFunc(r.Context(), st.pool, func(tx pgx.Tx) error {
			/* Resolved inside the transaction and locked, so two
			   reports of the same payment — the browser and the
			   webhook, arriving together — cannot both confirm. */
			err := tx.QueryRow(r.Context(), `
				SELECT c.id FROM crm.consultation_links l
				  JOIN crm.consultations c ON c.id = l.consultation_id
				 WHERE l.token = $1 AND l.purpose = 'checkout'
				 FOR UPDATE OF c`, token).Scan(&consultationID)
			if err != nil {
				return err
			}

			/* CONFIRMED, AND THE HOLD RETIRED. hold_expires_at goes
			   to NULL for the same reason it does when she answers by
			   hand: the hold has stopped meaning anything, and a
			   stale expiry would let the sweeper cancel an hour
			   somebody has paid for. */
			tag, err := tx.Exec(r.Context(), `
				UPDATE crm.consultations
				   SET status          = 'confirmed',
				       confirmed_at    = coalesce(confirmed_at, now()),
				       hold_expires_at = NULL,
				       updated_at      = now()
				 WHERE id = $1 AND status IN ('held', 'confirmed')`, consultationID)
			if err != nil {
				return err
			}
			if tag.RowsAffected() == 0 {
				return errors.New("that hour is no longer available")
			}

			/* The checkout is over. Retiring the link stops a
			   reloaded tab from presenting a paid hour as payable. */
			_, err = tx.Exec(r.Context(), `
				UPDATE crm.consultation_links
				   SET expires_at = now()
				 WHERE token = $1 AND purpose = 'checkout'`, token)
			return err
		})

		if err != nil {
			bad(w, 409, "not_confirmed", "that hour could not be confirmed")
			return
		}

		writeJSON(w, 200, map[string]any{"ok": true, "consultationId": consultationID})
	}
}
