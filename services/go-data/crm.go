// CRM — reads and writes against the crm schema
//
//	GET  /crm/overview                everything the hub shows, capped
//	GET  /crm/consultations?status=   the queue, today, or ahead
//	GET  /crm/people                  one row per person
//	GET  /crm/countries               the dropdown, hers pinned first
//	POST /crm/people                  register somebody (the chatbot)
//	POST /crm/consultations           hold a slot (the chatbot)
//	POST /crm/consultations/{id}/status   accept or decline (the CRM)
//
// The chatbot writes through here rather than touching Postgres: Go
// owns the database, and every route above requires the service token.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

/* ---- shapes ---------------------------------------------------- */

type person struct {
	ID      string  `json:"id"`
	Name    string  `json:"name"`
	Email   string  `json:"email"`
	Phone   *string `json:"phone"`
	DOB     *string `json:"dob"`
	Country *string `json:"country"`
}

type consultation struct {
	ID            string  `json:"id"`
	PersonID      string  `json:"personId"`
	Name          string  `json:"name"`
	Email         string  `json:"email"`
	Phone         *string `json:"phone"`
	Country       *string `json:"country"`
	Issue         string  `json:"focusArea"`
	Mode          string  `json:"mode"`
	Status        string  `json:"status"`
	StartAt       *string `json:"startAt"`
	HoldExpiresAt *string `json:"holdExpiresAt"`

	/* WHERE IT CAME FROM, WHAT THEY SAID, AND WHEN THEY ASKED.

	   A review request has no time on it, so the three things that
	   make its row readable are these: that it IS a review, the
	   sentence the client typed, and how long it has been waiting.
	   Without them her Requests page rendered a null start through
	   a date formatter and printed 1 January 1970. */
	Source    string  `json:"source"`
	Notes     *string `json:"notes"`
	CreatedAt string  `json:"createdAt"`
}

// The desk collects a country the way a person says it — "United
// Kingdom", "UK", "india". crm.people stores an ISO-2 code with a
// foreign key, so it has to be resolved before the insert.
//
// Done here rather than in Node deliberately: the list lives in this
// database, and a second copy of the mapping upstairs would be a
// second thing to update the day a country is added.
//
// Unresolvable text used to become NULL, on the reasoning that a
// country we cannot match is not a reason to lose somebody's booking.
// That reasoning was right and the place was wrong: it meant "Indea"
// was accepted, silently discarded, and the consultation saved with
// no country at all — nothing in the record to say one had ever been
// offered, and no way for her to know.
//
// The leniency moved upstream, where it can actually help. The desk
// now checks what they typed against this same list while it is still
// talking to them, and asks again if it cannot place it (see
// rules/countries.js). Nothing is lost, because nothing has been
// written yet.
//
// Which leaves this: a country that arrives here unresolvable can no
// longer be a visitor's spelling. It is a direct call or a fault, and
// answering those with a silent NULL is how the bug survived. So the
// second return says whether it resolved, and the caller refuses.
func (s *Store) resolveCountry(ctx context.Context, raw *string) (*string, bool) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil, true // not offered at all is fine, and always was
	}
	text := strings.TrimSpace(*raw)

	var iso string
	err := s.pool.QueryRow(ctx, `
		SELECT iso2 FROM crm.countries
		 WHERE upper(iso2) = upper($1)
		    OR lower(name) = lower($1)
		    -- "UK" and "USA" are what people actually type.
		    OR ($1 ILIKE 'uk'  AND iso2 = 'GB')
		    OR ($1 ILIKE 'usa' AND iso2 = 'US')
		    OR ($1 ILIKE 'uae' AND iso2 = 'AE')
		 LIMIT 1`, text).Scan(&iso)
	if err != nil {
		return nil, false
	}
	return &iso, true
}

// Days as she would say them, for messages she actually reads.
// Sunday is 0 to match the weekday column and Postgres's own DOW.
func weekdayName(d int) string {
	names := [...]string{"Sunday", "Monday", "Tuesday", "Wednesday",
		"Thursday", "Friday", "Saturday"}
	if d < 0 || d > 6 {
		return "That day"
	}
	return names[d]
}

func ts(t *time.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format(time.RFC3339)
	return &s
}

/* ---- reads ------------------------------------------------------ */

// One person per row, newest first. `sessions` is how many times they
// have booked — the reason people and consultations are separate
// tables in the first place.
/* A date with no time and no zone. dob is a DATE in Postgres, and
   formatting it as an instant is how somebody's birthday shifts by a
   day for every reader west of here. */
func dateOnly(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.Format("2006-01-02")
}

func (s *Store) crmPeople(ctx context.Context, limit int) ([]map[string]any, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id, p.name, p.email, p.phone, p.country_iso2, p.dob,
		       count(c.id)          AS sessions,
		       max(c.created_at)    AS last_seen
		  FROM crm.people p
		  LEFT JOIN crm.consultations c ON c.person_id = p.id
		 GROUP BY p.id
		 ORDER BY max(c.created_at) DESC NULLS LAST, p.created_at DESC
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var id, name, email string
		var phone, country *string
		/* Date of birth, because age is what turns a weight into an
		   assessment — it drives the energy estimate and half the
		   reference ranges. It was omitted here and the assessment
		   form had nothing to prefill from. */
		var dob *time.Time
		var sessions int
		var lastSeen *time.Time
		if err := rows.Scan(&id, &name, &email, &phone, &country, &dob, &sessions, &lastSeen); err != nil {
			return nil, err
		}
		out = append(out, map[string]any{
			"id": id, "name": name, "email": email, "phone": phone, "dob": dateOnly(dob),
			"country": country, "sessions": sessions, "lastSeenAt": ts(lastSeen),
		})
	}
	return out, rows.Err()
}

// The queue, today, or ahead — one query, three windows.
func (s *Store) crmConsultations(ctx context.Context, window string, limit int) ([]consultation, error) {
	var where string
	switch window {
	case "held":
		where = `c.status = 'held'`
	case "today":
		where = `c.status = 'confirmed' AND c.scheduled_start_at::date = current_date`
	case "upcoming":
		where = `c.status = 'confirmed' AND c.scheduled_start_at > now() AND c.scheduled_start_at::date > current_date`
	/* Sessions that have fallen off the end of an earlier day with
	   nothing said about them. Recording an outcome moves a booking
	   off 'confirmed', so "still confirmed, and its day has gone" is
	   precisely the set nobody has answered for. */
	case "overdue":
		where = `c.status = 'confirmed' AND c.scheduled_start_at < current_date`
	default:
		where = `true`
	}

	rows, err := s.pool.Query(ctx, `
		SELECT c.id, c.person_id, p.name, p.email, p.phone, p.country_iso2,
		       c.issue, c.mode, c.status, c.scheduled_start_at, c.hold_expires_at,
		       c.source, c.notes, c.created_at
		  FROM crm.consultations c
		  JOIN crm.people p ON p.id = c.person_id
		 WHERE `+where+`
		 ORDER BY c.scheduled_start_at NULLS LAST, c.created_at
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []consultation{}
	for rows.Next() {
		var c consultation
		var start, hold *time.Time
		var created time.Time
		if err := rows.Scan(&c.ID, &c.PersonID, &c.Name, &c.Email, &c.Phone, &c.Country,
			&c.Issue, &c.Mode, &c.Status, &start, &hold,
			&c.Source, &c.Notes, &created); err != nil {
			return nil, err
		}
		c.StartAt, c.HoldExpiresAt = ts(start), ts(hold)
		c.CreatedAt = created.Format(time.RFC3339)
		out = append(out, c)
	}
	return out, rows.Err()
}

/* ---- writes ----------------------------------------------------- */

// upsertPerson is how the chatbot registers somebody. Email is the
// identity, so booking a second time updates the record rather than
// creating a twin — which is the whole point of crm.people.
//
// COALESCE on update: a later booking that omits a phone number must
// not erase the one already on file.
func (s *Store) upsertPerson(ctx context.Context, in person, source string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `
		INSERT INTO crm.people (name, email, phone, dob, country_iso2, source)
		VALUES ($1, lower($2), $3, $4::date, $5, $6)
		ON CONFLICT (lower(email)) DO UPDATE SET
		  name         = EXCLUDED.name,
		  phone        = COALESCE(EXCLUDED.phone,        crm.people.phone),
		  dob          = COALESCE(EXCLUDED.dob,          crm.people.dob),
		  country_iso2 = COALESCE(EXCLUDED.country_iso2, crm.people.country_iso2),
		  updated_at   = now()
		RETURNING id`,
		strings.TrimSpace(in.Name), strings.TrimSpace(in.Email),
		in.Phone, in.DOB, in.Country, source).Scan(&id)
	return id, err
}

/* ---- handlers ---------------------------------------------------- */

func crmOverview(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		held, err := st.crmConsultations(ctx, "held", 20)
		if err != nil {
			bad(w, 500, "query_failed", "could not read the queue")
			return
		}
		today, _ := st.crmConsultations(ctx, "today", 20)
		ahead, _ := st.crmConsultations(ctx, "upcoming", 20)
		people, _ := st.crmPeople(ctx, 5)

		writeJSON(w, 200, map[string]any{
			"counts": map[string]int{
				"waiting": len(held), "today": len(today), "upcoming": len(ahead),
			},
			"waiting": held, "today": today, "upcoming": ahead, "people": people,
		})
	}
}

func crmConsultationsHandler(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		window := r.URL.Query().Get("status")
		list, err := st.crmConsultations(r.Context(), window, 200)
		if err != nil {
			bad(w, 500, "query_failed", "could not read consultations")
			return
		}
		held, _ := st.crmConsultations(r.Context(), "held", 200)
		today, _ := st.crmConsultations(r.Context(), "today", 200)
		ahead, _ := st.crmConsultations(r.Context(), "upcoming", 200)

		writeJSON(w, 200, map[string]any{
			"consultations": list,
			"counts": map[string]int{
				"waiting": len(held), "today": len(today), "upcoming": len(ahead),
			},
		})
	}
}

func crmPeopleHandler(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		list, err := st.crmPeople(r.Context(), 200)
		if err != nil {
			bad(w, 500, "query_failed", "could not read people")
			return
		}
		writeJSON(w, 200, map[string]any{"people": list})
	}
}

// The dropdown. Hers pin to the top; everything else follows
// alphabetically, because "any country" was the other half of her
// answer.
func crmCountries(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := st.pool.Query(r.Context(), `
			SELECT iso2, name, dial_code, phone_digits, priority IS NOT NULL
			  FROM crm.countries
			 WHERE active
			 ORDER BY priority NULLS LAST, name`)
		if err != nil {
			bad(w, 500, "query_failed", "could not read countries")
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var iso, name, dial string
			var digits []int16
			var pinned bool
			if err := rows.Scan(&iso, &name, &dial, &digits, &pinned); err != nil {
				bad(w, 500, "scan_failed", "could not read a country")
				return
			}
			out = append(out, map[string]any{
				"iso2": iso, "name": name, "dialCode": dial,
				"digits": digits, "pinned": pinned,
			})
		}
		writeJSON(w, 200, map[string]any{"countries": out})
	}
}

// GET /crm/hours — her published week, and the days that break it.
//
// The same two tables the slot engine reads, so the Hours page shows
// exactly what the desk offers from. A second source for "when does
// she work" is a second thing to disagree.
func crmHours(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		rules := []map[string]any{}
		rows, err := st.pool.Query(ctx, `
			SELECT id, weekday, starts_min, ends_min, effective_from, effective_to
			  FROM availability_rules
			 WHERE effective_from <= current_date
			   AND (effective_to IS NULL OR effective_to >= current_date)
			 ORDER BY weekday, starts_min`)
		if err != nil {
			bad(w, 500, "query_failed", "could not read the week")
			return
		}
		for rows.Next() {
			var id string
			var dow, a, b int
			var from time.Time
			var to *time.Time
			if err := rows.Scan(&id, &dow, &a, &b, &from, &to); err != nil {
				rows.Close()
				bad(w, 500, "scan_failed", "could not read a rule")
				return
			}
			rules = append(rules, map[string]any{
				"id": id, "weekday": dow, "startsMin": a, "endsMin": b,
				"effectiveFrom": from.Format("2006-01-02"),
				"effectiveTo": func() any {
					if to == nil {
						return nil
					}
					return to.Format("2006-01-02")
				}(),
			})
		}
		rows.Close()

		exceptions := []map[string]any{}
		erows, err := st.pool.Query(ctx, `
			SELECT id, on_date, kind, starts_min, ends_min, reason
			  FROM availability_exceptions
			 WHERE on_date >= current_date
			 ORDER BY on_date`)
		if err != nil {
			bad(w, 500, "query_failed", "could not read the exceptions")
			return
		}
		defer erows.Close()
		for erows.Next() {
			var id, kind string
			var on time.Time
			var a, b *int
			var reason *string
			if err := erows.Scan(&id, &on, &kind, &a, &b, &reason); err != nil {
				bad(w, 500, "scan_failed", "could not read an exception")
				return
			}
			exceptions = append(exceptions, map[string]any{
				"id": id, "onDate": on.Format("2006-01-02"), "kind": kind,
				"startsMin": a, "endsMin": b, "reason": reason,
			})
		}

		writeJSON(w, 200, map[string]any{"rules": rules, "exceptions": exceptions})
	}
}

/* ---- editing her week -------------------------------------------

   Bulk by design. "Tuesdays and Thursdays, 11:00-13:00" is ONE action
   with a list of weekdays, not two visits to a form — a weekly pattern
   she has to enter a day at a time is one she stops maintaining, and a
   stale pattern means the desk offers hours she is not working.

   All of it in one transaction: half a pattern is worse than none,
   because it looks deliberate. */

// POST /crm/hours/rules  {weekdays:[2,4], startsMin:660, endsMin:780}
func crmAddRules(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Weekdays  []int   `json:"weekdays"`
			StartsMin int     `json:"startsMin"`
			EndsMin   int     `json:"endsMin"`
			From      *string `json:"effectiveFrom"`
			To        *string `json:"effectiveTo"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if len(in.Weekdays) == 0 {
			bad(w, 400, "invalid", "pick at least one day")
			return
		}
		// Checked here as well as by the CHECK constraints, so she gets
		// a sentence rather than a constraint violation.
		if in.StartsMin < 0 || in.EndsMin > 1440 || in.EndsMin <= in.StartsMin {
			bad(w, 400, "invalid", "the finish time has to be after the start")
			return
		}

		tx, err := st.pool.Begin(r.Context())
		if err != nil {
			bad(w, 500, "write_failed", "could not start")
			return
		}
		defer tx.Rollback(r.Context())

		added := 0
		var noEffect []string

		for _, dow := range in.Weekdays {
			if dow < 0 || dow > 6 {
				bad(w, 400, "invalid", "that is not a day of the week")
				return
			}

			/* A band that sits entirely inside one she already has is
			   legal and does nothing — bands are additive, so the wider
			   one still governs the day. Saving it silently is how she
			   ends up believing she has narrowed a Monday that is in
			   fact still open from ten.

			   Checked before the insert, inside the same transaction,
			   so the answer cannot be stale by the time she reads it. */
			var covers string
			err := tx.QueryRow(r.Context(), `
				SELECT to_char((starts_min || ' minutes')::interval, 'HH24:MI')
				       || '-' ||
				       to_char((ends_min   || ' minutes')::interval, 'HH24:MI')
				  FROM availability_rules
				 WHERE weekday = $1
				   AND starts_min <= $2 AND ends_min >= $3
				   AND daterange(effective_from, effective_to, '[]')
				       @> COALESCE($4::date, CURRENT_DATE)
				 LIMIT 1`,
				dow, in.StartsMin, in.EndsMin, in.From).Scan(&covers)
			// No row is the ordinary case: nothing already covers it.
			// Any other error is not worth failing her write over —
			// this check is advice, not a gate.
			if err != nil {
				// No row is the ordinary case. Anything else is a fault
				// in this check, not in her request — so it is logged
				// rather than swallowed, and her band still saves.
				if !errors.Is(err, pgx.ErrNoRows) {
					log.Printf("[go-data] coverage check failed: %v", err)
				}
				covers = ""
			}
			if covers != "" {
				noEffect = append(noEffect, weekdayName(dow)+" is already open "+covers)
			}

			if _, err := tx.Exec(r.Context(), `
				INSERT INTO availability_rules
				  (weekday, starts_min, ends_min, effective_from, effective_to)
				VALUES ($1, $2, $3, COALESCE($4::date, CURRENT_DATE), $5::date)`,
				dow, in.StartsMin, in.EndsMin, in.From, in.To); err != nil {
				/* availability_rules_once, added in 0007. She clicked
				   twice, or the request arrived twice. Saying so beats
				   "could not save that band", which reads like a fault
				   and invites another click — which is what produced
				   the duplicate in the first place. */
				var pgErr *pgconn.PgError
				if errors.As(err, &pgErr) {
					/* 23505 is the exact duplicate (migration 0007);
					   23P01 is the overlap (0011). Two codes, one
					   thing as far as she is concerned: that time is
					   already covered. */
					if pgErr.Code == "23505" || pgErr.Code == "23P01" {
						bad(w, 409, "already_covered",
							weekdayName(dow)+" is already covered at that time")
						return
					}
				}
				bad(w, 500, "write_failed", "could not save that band")
				return
			}
			added++
		}
		if err := tx.Commit(r.Context()); err != nil {
			bad(w, 500, "write_failed", "could not save the pattern")
			return
		}

		out := map[string]any{"ok": true, "added": added}
		// Saved, and worth knowing. Not an error: she asked for it and
		// she got it; it simply will not change what a visitor is
		// offered, and only she can decide whether that is what she meant.
		if len(noEffect) > 0 {
			out["noEffect"] = noEffect
		}
		writeJSON(w, 201, out)
	}
}

// DELETE /crm/hours/rules/{id}
func crmDropRule(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tag, err := st.pool.Exec(r.Context(),
			`DELETE FROM availability_rules WHERE id = $1`, r.PathValue("id"))
		if err != nil {
			bad(w, 500, "write_failed", "could not remove that band")
			return
		}
		if tag.RowsAffected() == 0 {
			bad(w, 404, "not_found", "no such band")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

// POST /crm/hours/exceptions  {onDate, kind, startsMin?, endsMin?, reason?}
func crmAddException(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			OnDate    string  `json:"onDate"`
			Kind      string  `json:"kind"`
			StartsMin *int    `json:"startsMin"`
			EndsMin   *int    `json:"endsMin"`
			Reason    *string `json:"reason"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.Kind != "closed" && in.Kind != "open" {
			bad(w, 400, "invalid", "an exception either closes a day or opens one")
			return
		}
		if in.Kind == "open" && (in.StartsMin == nil || in.EndsMin == nil) {
			bad(w, 400, "invalid", "an extra opening needs a start and a finish")
			return
		}
		if in.Kind == "closed" {
			// A closure shuts the whole day; times would be ignored, and
			// silently ignoring input is how people lose trust in a form.
			in.StartsMin, in.EndsMin = nil, nil
		}

		/* A DAY THAT HAS GONE CANNOT BE SCHEDULED.

		   Closing last Tuesday changes nothing a visitor can be
		   offered and nothing that already happened; it only puts a
		   claim in the record that she was shut on a day she was not.
		   The same for a one-off opening — an hour in the past cannot
		   be booked, so offering it is an entry that will never mean
		   anything.

		   COMPARED IN HER TIMEZONE, not the database's. `current_date`
		   is whatever the server thinks the day is, and a box running
		   UTC is a day behind Kolkata for five and a half hours every
		   night — long enough for "today" to be refused as past. */
		loc, err := time.LoadLocation(st.cfg.Timezone)
		if err != nil {
			loc = time.UTC
		}
		when, err := time.ParseInLocation("2006-01-02", in.OnDate, loc)
		if err != nil {
			bad(w, 400, "invalid", "that is not a date")
			return
		}
		now := time.Now().In(loc)
		today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
		if when.Before(today) {
			bad(w, 400, "already_past",
				"that day has already been and gone — pick today or later")
			return
		}

		var id string
		err = st.pool.QueryRow(r.Context(), `
			INSERT INTO availability_exceptions (on_date, kind, starts_min, ends_min, reason)
			VALUES ($1::date, $2, $3, $4, $5)
			RETURNING id`,
			in.OnDate, in.Kind, in.StartsMin, in.EndsMin, in.Reason).Scan(&id)
		if err != nil {
			if strings.Contains(err.Error(), "availability_exceptions_closed_once") {
				bad(w, http.StatusConflict, "already_closed", "that date is already closed")
				return
			}
			bad(w, 500, "write_failed", "could not save that")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true, "id": id})
	}
}

// DELETE /crm/hours/exceptions/{id}
func crmDropException(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tag, err := st.pool.Exec(r.Context(),
			`DELETE FROM availability_exceptions WHERE id = $1`, r.PathValue("id"))
		if err != nil {
			bad(w, 500, "write_failed", "could not remove that")
			return
		}
		if tag.RowsAffected() == 0 {
			bad(w, 404, "not_found", "no such exception")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

// POST /crm/people — the chatbot registering a visitor.
func crmRegisterPerson(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			person
			Source string `json:"source"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if strings.TrimSpace(in.Name) == "" || !strings.Contains(in.Email, "@") {
			bad(w, 400, "invalid", "a name and an email address are required")
			return
		}
		if in.Source == "" {
			in.Source = "chatbot"
		}

		id, err := st.upsertPerson(r.Context(), in.person, in.Source)
		if err != nil {
			bad(w, 500, "write_failed", "could not save that person")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true, "personId": id})
	}
}

// POST /crm/consultations — the chatbot holding a slot.
//
// Person and consultation are written in ONE transaction: a person
// with no consultation is a record of somebody who never booked, and
// a consultation with no person cannot exist at all.
func crmCreateConsultation(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			person
			Issue    string  `json:"focusArea"`
			Mode     string  `json:"mode"`
			StartAt  *string `json:"startAt"`
			EndAt    *string `json:"endAt"`
			HoldFor  *string `json:"holdExpiresAt"`
			Timezone *string `json:"timezone"`
			Notes    *string `json:"notes"`
			Source   string  `json:"source"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if strings.TrimSpace(in.Name) == "" || !strings.Contains(in.Email, "@") || in.Issue == "" {
			bad(w, 400, "invalid", "a name, an email address and a focus area are required")
			return
		}
		if in.Mode == "" {
			in.Mode = "undecided"
		}
		if in.Source == "" {
			in.Source = "chatbot"
		}

		iso, known := st.resolveCountry(r.Context(), in.Country)
		if !known {
			bad(w, 400, "unknown_country",
				"that country is not one this practice has on file")
			return
		}

		tx, err := st.pool.Begin(r.Context())
		if err != nil {
			bad(w, 500, "write_failed", "could not start")
			return
		}
		defer tx.Rollback(r.Context())

		var personID string
		if err := tx.QueryRow(r.Context(), `
			INSERT INTO crm.people (name, email, phone, dob, country_iso2, source)
			VALUES ($1, lower($2), $3, $4::date, $5, $6)
			ON CONFLICT (lower(email)) DO UPDATE SET
			  name         = EXCLUDED.name,
			  phone        = COALESCE(EXCLUDED.phone,        crm.people.phone),
			  dob          = COALESCE(EXCLUDED.dob,          crm.people.dob),
			  country_iso2 = COALESCE(EXCLUDED.country_iso2, crm.people.country_iso2),
			  updated_at   = now()
			RETURNING id`,
			strings.TrimSpace(in.Name), strings.TrimSpace(in.Email),
			in.Phone, in.DOB, iso, in.Source).Scan(&personID); err != nil {
			bad(w, 500, "write_failed", "could not save that person")
			return
		}

		var id string
		err = tx.QueryRow(r.Context(), `
			INSERT INTO crm.consultations
			  (person_id, issue, mode, status, scheduled_start_at, scheduled_end_at,
			   hold_expires_at, timezone, notes)
			VALUES ($1, $2, $3, 'held', $4::timestamptz, $5::timestamptz,
			        $6::timestamptz, $7, $8)
			RETURNING id`,
			personID, in.Issue, in.Mode, in.StartAt, in.EndAt, in.HoldFor,
			in.Timezone, in.Notes).Scan(&id)

		if err != nil {
			// The partial unique index refused it: somebody else took
			// that slot between it being offered and this write. That
			// is the guard working, not a fault — say so precisely so
			// the desk can offer another time.
			if strings.Contains(err.Error(), "consultations_slot_unique") {
				bad(w, http.StatusConflict, "slot_taken", "that time has just been taken")
				return
			}
			bad(w, 500, "write_failed", "could not save that booking")
			return
		}

		if err := tx.Commit(r.Context()); err != nil {
			bad(w, 500, "write_failed", "could not save that booking")
			return
		}

		writeJSON(w, 201, map[string]any{"ok": true, "personId": personID, "consultationId": id})
	}
}

// POST /crm/consultations/{id}/status — she accepts or declines.
func crmSetStatus(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")

		var in struct {
			Status string `json:"status"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		switch in.Status {
		case "confirmed", "declined", "cancelled", "completed", "no_show":
		default:
			bad(w, 400, "invalid", "not a status a booking can be moved to")
			return
		}

		tag, err := st.pool.Exec(r.Context(), `
			UPDATE crm.consultations
			   SET status       = $2,
			       confirmed_at = CASE WHEN $2 = 'confirmed' THEN now() ELSE confirmed_at END,
			       -- Once she has answered, the hold stops meaning
			       -- anything and must not keep blocking the slot.
			       hold_expires_at = NULL,
			       updated_at   = now()
			 WHERE id = $1
			   -- A CONFIRMATION NEEDS AN HOUR TO CONFIRM.
			   --
			   -- Review requests arrive with no time on them: the
			   -- client is asking, she is offering. Accepting one
			   -- would leave a confirmed session with a null start,
			   -- which puts a row on Today that has no hour, and
			   -- sends a confirmation email naming no date. The
			   -- Requests page offers "Offer a time" instead of
			   -- Accept on those rows, but a page is not a guard —
			   -- this is. /crm/consultations/{id}/schedule is the
			   -- one door that sets a time and confirms together.
			   AND ($2 <> 'confirmed' OR scheduled_start_at IS NOT NULL)`, id, in.Status)
		if err != nil {
			bad(w, 500, "write_failed", "could not update that booking")
			return
		}
		if tag.RowsAffected() == 0 {
			/* Which of the two it was, since they need different
			   things from her. */
			var exists, timed bool
			_ = st.pool.QueryRow(r.Context(),
				`SELECT true, scheduled_start_at IS NOT NULL FROM crm.consultations WHERE id = $1`, id).
				Scan(&exists, &timed)
			if exists && !timed {
				bad(w, 409, "needs_a_time",
					"that request has no hour yet — offer one instead of accepting it")
				return
			}
			bad(w, 404, "not_found", "no such booking")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "id": id, "status": in.Status})
	}
}

// GET /crm/hours/clash?weekdays=1,2&startsMin=660&endsMin=780
//
// Which of the chosen days already have something at that time.
//
// The CRM asks before it offers the button, so "Add" is simply not
// clickable rather than clickable-then-refused. A control that looks
// available and then says no has taught the user nothing except not
// to trust it.
func crmHoursClash(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		startsMin, _ := strconv.Atoi(q.Get("startsMin"))
		endsMin, _ := strconv.Atoi(q.Get("endsMin"))
		if endsMin <= startsMin {
			writeJSON(w, 200, map[string]any{"ok": true, "clashes": []any{}})
			return
		}

		clashes := []map[string]any{}
		for _, part := range strings.Split(q.Get("weekdays"), ",") {
			dow, err := strconv.Atoi(strings.TrimSpace(part))
			if err != nil || dow < 0 || dow > 6 {
				continue
			}

			var existing string
			err = st.pool.QueryRow(r.Context(), `
				SELECT to_char((starts_min || ' minutes')::interval, 'HH24:MI')
				       || '-' ||
				       to_char((ends_min   || ' minutes')::interval, 'HH24:MI')
				  FROM availability_rules
				 WHERE weekday = $1
				   AND int4range(starts_min, ends_min) && int4range($2, $3)
				   AND daterange(effective_from, effective_to, '[]') @> CURRENT_DATE
				 LIMIT 1`, dow, startsMin, endsMin).Scan(&existing)
			if err == nil && existing != "" {
				clashes = append(clashes, map[string]any{
					"weekday": dow,
					"day":     weekdayName(dow),
					"with":    existing,
				})
			}
		}

		writeJSON(w, 200, map[string]any{"ok": true, "clashes": clashes})
	}
}
