// Programmes — the client working through their plan, day by day
//
//	POST /crm/plans/{id}/programme   start one (or return the live one)
//	POST /crm/programmes/{id}/revoke kill the token
//	GET  /crm/programmes?personId=   what she sees
//	GET  /crm/adherence?programmeId= how it is going
//
//	GET  /programme/{token}          resolve it — PUBLIC
//	POST /programme/{token}/checkin  a tick — PUBLIC
//	POST /programme/{token}/weight   a weight — PUBLIC
//
// THE PUBLIC ROUTES HERE ACCEPT WRITES, which no other public route
// in this service does. The plan link reads; the consultation link
// reads; this one takes rows from somebody holding a string. So:
// every write is bounded (a known programme, a known item of THEIR
// plan, a date near today), every write is append-only, and nothing
// a client sends can change what she wrote.
//
// WHAT A CLIENT CAN NEVER REACH FROM HERE: another person, another
// plan, the private note, an unconfirmed row, or any row of a plan
// that is not the one their programme points at.
package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

/* How long a programme's token lives before it is simply refused.
   Long enough for a course of treatment and its follow-up; short
   enough that an abandoned link is not a standing door. */
const programmeLives = 400 * 24 * time.Hour

type programme struct {
	ID         string  `json:"id"`
	PersonID   string  `json:"personId"`
	PersonName string  `json:"personName"`
	PlanNo     int     `json:"planNo"`
	Status     string  `json:"status"`
	StartedOn  string  `json:"startedOn"`
	OpenedAt   *string `json:"openedAt"`
	OpenCount  int     `json:"openCount"`

	/* How long it runs — 30, 60 or 90 — and the last day it covers.
	   `endsOn` is derived here rather than in three front ends, all
	   of which would get the off-by-one differently: a 30-day
	   programme started on the 1st ends on the 30th, not the 31st. */
	LengthDays int    `json:"lengthDays"`
	EndsOn     string `json:"endsOn"`
}

/* The lengths she may choose. A course of treatment, not a rolling
   window — see migration 0027. */
func validLength(n int) bool { return n == 30 || n == 60 || n == 90 }

/* The last day a programme covers. Day one is the day it started,
   so a thirty-day programme beginning on the 1st ends on the 30th.
   Written once, here, because the off-by-one is the kind that three
   front ends get three different ways. */
func endsOn(started time.Time, length int) string {
	if length <= 0 {
		length = 30
	}
	return started.AddDate(0, 0, length-1).Format("2006-01-02")
}

/* ---- her side --------------------------------------------------- */

// POST /crm/plans/{id}/programme
func crmProgrammeStart(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		ctx := r.Context()

		/* How long it runs. Defaulted rather than required, so a
		   caller that has not been updated still starts a programme
		   rather than failing — and refused if it is a number she
		   was never offered. */
		var in struct {
			Days int `json:"days"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<10)).Decode(&in)
		if in.Days == 0 {
			in.Days = 30
		}
		if !validLength(in.Days) {
			bad(w, 400, "invalid", "a programme runs for 30, 60 or 90 days")
			return
		}

		var personID string
		var planNo int
		var status string
		if err := st.pool.QueryRow(ctx,
			`SELECT person_id, plan_no, status FROM crm.plans WHERE id = $1`, id).
			Scan(&personID, &planNo, &status); err != nil {
			bad(w, 404, "not_found", "no plan with that reference")
			return
		}
		if status != "issued" {
			bad(w, 409, "not_issued", "issue the plan first — a draft is not something to follow")
			return
		}

		/* A programme with nothing to tick is a blank app. Better to
		   refuse it here than to hand somebody a link to an empty
		   list and have them conclude the whole thing is broken. */
		var live int
		_ = st.pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM crm.plan_items
			 WHERE plan_id = $1 AND status IN ('confirmed', 'edited')`, id).Scan(&live)
		if live == 0 {
			bad(w, 409, "no_items", "confirm some rows first — there would be nothing to tick")
			return
		}

		token, err := newToken()
		if err != nil {
			bad(w, 500, "no_token", "could not make a link")
			return
		}

		/* MINT-OR-RETURN on the live one. Pressing the button twice
		   must not leave a client holding two apps that disagree about
		   what they did yesterday.

		   THE ROW IS READ OUT OF THE CTEs, NEVER BACK OFF THE TABLE,
		   and that is the whole reason this statement looks like this.
		   A data-modifying CTE and the query around it share ONE
		   snapshot, taken before either ran — so a plain
		   `SELECT ... FROM crm.programmes WHERE id = (SELECT id FROM
		   made)` cannot see the row `made` just inserted. It returned
		   no rows, the Scan failed, and the FIRST press of Start
		   answered "could not start that" while quietly creating the
		   programme; the second press found it through `existing` and
		   worked. Self-healing, invisible in a log, and it would have
		   taught her that this button needs pressing twice.

		   UNION ALL rather than COALESCE because exactly one of the
		   two branches ever has a row: `made` inserts only when
		   `existing` is empty. crm.people is joined normally — it is
		   not being modified here, so the snapshot is no obstacle. */
		var out programme
		var opened *time.Time
		var started time.Time
		err = st.pool.QueryRow(ctx, `
			WITH existing AS (
			  SELECT id, person_id, plan_no, status, started_on, opened_at, open_count, length_days
			    FROM crm.programmes
			   WHERE person_id = $2 AND plan_no = $3 AND status = 'active'
			), made AS (
			  INSERT INTO crm.programmes (token, person_id, plan_no, length_days)
			  SELECT $1, $2, $3, $4
			   WHERE NOT EXISTS (SELECT 1 FROM existing)
			  RETURNING id, person_id, plan_no, status, started_on, opened_at, open_count, length_days
			), picked AS (
			  SELECT * FROM made
			  UNION ALL
			  SELECT * FROM existing
			)
			SELECT pk.id, pk.person_id, pe.name, pk.plan_no, pk.status,
			       pk.started_on, pk.opened_at, pk.open_count, pk.length_days
			  FROM picked pk
			  JOIN crm.people pe ON pe.id = pk.person_id`,
			token, personID, planNo, in.Days).
			Scan(&out.ID, &out.PersonID, &out.PersonName, &out.PlanNo, &out.Status,
				&started, &opened, &out.OpenCount, &out.LengthDays)
		if err != nil {
			bad(w, 500, "not_started", "could not start that")
			return
		}
		out.StartedOn = started.Format("2006-01-02")
		out.EndsOn = endsOn(started, out.LengthDays)
		out.OpenedAt = ts(opened)

		// The token is returned once, here. It is never listed again.
		var tok string
		_ = st.pool.QueryRow(ctx, `SELECT token FROM crm.programmes WHERE id = $1`, out.ID).Scan(&tok)

		writeJSON(w, 200, map[string]any{"ok": true, "programme": out, "token": tok})
	}
}

// POST /crm/programmes/{id}/revoke
func crmProgrammeRevoke(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tag, err := st.pool.Exec(r.Context(), `
			UPDATE crm.programmes
			   SET status = 'revoked', revoked_at = now()
			 WHERE id = $1 AND status = 'active'`, r.PathValue("id"))
		if err != nil {
			bad(w, 500, "not_revoked", "could not stop that")
			return
		}
		if tag.RowsAffected() == 0 {
			bad(w, 409, "not_active", "that programme is not running")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

// GET /crm/programmes?personId=
func crmProgrammeList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := st.pool.Query(r.Context(), `
			SELECT p.id, p.person_id, pe.name, p.plan_no, p.status,
			       p.started_on, p.opened_at, p.open_count, p.length_days
			  FROM crm.programmes p
			  JOIN crm.people pe ON pe.id = p.person_id
			 WHERE ($1 = '' OR p.person_id = $1::uuid)
			 ORDER BY p.started_on DESC`, r.URL.Query().Get("personId"))
		if err != nil {
			bad(w, 500, "read_failed", "could not read those")
			return
		}
		defer rows.Close()

		out := []programme{}
		for rows.Next() {
			var p programme
			var opened *time.Time
			var started time.Time
			if err := rows.Scan(&p.ID, &p.PersonID, &p.PersonName, &p.PlanNo, &p.Status,
				&started, &opened, &p.OpenCount, &p.LengthDays); err != nil {
				continue
			}
			p.StartedOn = started.Format("2006-01-02")
			p.EndsOn = endsOn(started, p.LengthDays)
			p.OpenedAt = ts(opened)
			out = append(out, p)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "programmes": out})
	}
}

/* GET /crm/adherence?programmeId=&days=

   How it is actually going, per row, over a window. Counted from the
   LATEST check-in for each day, because a correction supersedes what
   it corrects and counting both would make somebody who fixed a
   mistake look twice as diligent. */
func crmAdherence(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("programmeId")
		if id == "" {
			bad(w, 400, "invalid", "a programme is needed")
			return
		}
		days := clampInt(r.URL.Query().Get("days"), 28, 1, 365)

		rows, err := st.pool.Query(r.Context(), `
			WITH latest AS (
			  SELECT DISTINCT ON (plan_item_id, on_date)
			         plan_item_id, on_date, state
			    FROM crm.checkins
			   WHERE programme_id = $1
			     AND on_date > current_date - $2::int
			   ORDER BY plan_item_id, on_date, at DESC
			)
			SELECT i.id, i.label, i.kind,
			       COUNT(*) FILTER (WHERE l.state = 'done') AS done,
			       COUNT(*) FILTER (WHERE l.state = 'part') AS part,
			       COUNT(*) FILTER (WHERE l.state = 'skip') AS skip
			  FROM crm.plan_items i
			  LEFT JOIN latest l ON l.plan_item_id = i.id
			 WHERE i.plan_id = (
			         SELECT pl.id FROM crm.plans pl
			           JOIN crm.programmes pr ON pr.person_id = pl.person_id
			                                 AND pr.plan_no = pl.plan_no
			          WHERE pr.id = $1 AND pl.status = 'issued'
			          ORDER BY pl.amendment DESC LIMIT 1)
			   AND i.status IN ('confirmed', 'edited')
			 GROUP BY i.id, i.label, i.kind, i.seq
			 ORDER BY i.seq`, id, days)
		if err != nil {
			bad(w, 500, "read_failed", "could not read that")
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var itemID, label, kind string
			var done, part, skip int
			if err := rows.Scan(&itemID, &label, &kind, &done, &part, &skip); err != nil {
				continue
			}
			out = append(out, map[string]any{
				"itemId": itemID, "label": label, "kind": kind,
				"done": done, "part": part, "skip": skip,
				"reported": done + part + skip, "days": days,
			})
		}
		writeJSON(w, 200, map[string]any{"ok": true, "adherence": out})
	}
}

/* ---- the client's side, all public ------------------------------ */

/* Resolve a programme token to everything the app needs and nothing
   else. Same refusal for every failure — unknown, revoked, ended,
   expired, person erased — because telling them apart leaks whether
   a token was ever real. */
func (s *Store) programmeFor(r *http.Request, token string) (string, string, int, bool) {
	if len(token) < 16 || len(token) > 64 {
		return "", "", 0, false
	}
	var id, personID string
	var planNo int
	err := s.pool.QueryRow(r.Context(), `
		SELECT id, person_id, plan_no FROM crm.programmes
		 WHERE token = $1 AND status = 'active'
		   AND created_at > now() - $2::interval`, token, programmeLives.String()).
		Scan(&id, &personID, &planNo)
	return id, personID, planNo, err == nil
}

// GET /programme/{token} — PUBLIC
func programmeResolve(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := r.PathValue("token")
		progID, personID, planNo, ok := st.programmeFor(r, token)
		if !ok {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}
		ctx := r.Context()

		var firstName string
		_ = st.pool.QueryRow(ctx,
			`SELECT split_part(btrim(name), ' ', 1) FROM crm.people WHERE id = $1`,
			personID).Scan(&firstName)

		/* The CURRENT issued version of their plan. Same rule as the
		   plan link: she corrects a plan because the old one was
		   wrong, and the person following it moves with it. */
		var planID, planRef string
		if err := st.pool.QueryRow(ctx, `
			SELECT id, ref FROM crm.plans
			 WHERE person_id = $1 AND plan_no = $2 AND status = 'issued'
			 ORDER BY amendment DESC LIMIT 1`, personID, planNo).Scan(&planID, &planRef); err != nil {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}

		/* CONFIRMED ROWS ONLY, and the filter is here rather than in
		   the caller. A proposal she never ruled on is a model's
		   guess, and a client's app is the last place it should
		   appear. */
		rows, err := st.pool.Query(ctx, `
			SELECT id, kind, label, quantity, unit, schedule
			  FROM crm.plan_items
			 WHERE plan_id = $1 AND status IN ('confirmed', 'edited')
			 ORDER BY seq`, planID)
		if err != nil {
			bad(w, 500, "read_failed", "could not read that")
			return
		}
		defer rows.Close()

		items := []map[string]any{}
		for rows.Next() {
			var id, kind, label, unit, schedule string
			var qty *float64
			if err := rows.Scan(&id, &kind, &label, &qty, &unit, &schedule); err != nil {
				continue
			}
			items = append(items, map[string]any{
				"id": id, "kind": kind, "label": label,
				"quantity": qty, "unit": unit, "schedule": schedule,
			})
		}

		_, _ = st.pool.Exec(ctx, `
			UPDATE crm.programmes
			   SET opened_at = COALESCE(opened_at, now()), open_count = open_count + 1
			 WHERE id = $1`, progID)

		/* THE WINDOW THE PLAN ACTUALLY COVERS. The app draws exactly
		   this and nothing outside it: a programme is a course of
		   treatment with a beginning and an end, not a rolling month
		   that drifts forward for ever. Their own dates are not a
		   disclosure — they were there — and without them the
		   calendar either guesses or pages back through empty years. */
		var startedOn time.Time
		var length int
		_ = st.pool.QueryRow(ctx,
			`SELECT started_on, length_days FROM crm.programmes WHERE id = $1`,
			progID).Scan(&startedOn, &length)

		writeJSON(w, 200, map[string]any{
			"ok": true, "firstName": firstName, "ref": planRef, "items": items,
			"startedOn":  startedOn.Format("2006-01-02"),
			"endsOn":     endsOn(startedOn, length),
			"lengthDays": length,
		})
	}
}

// GET /programme/{token}/days?from=&to= — PUBLIC. What they already said.
func programmeDays(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		progID, _, _, ok := st.programmeFor(r, r.PathValue("token"))
		if !ok {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}

		/* THE WHOLE COURSE, NOT THE LAST FIVE WEEKS.

		   This was `on_date > current_date - 35`, which was fine while
		   the app only drew a strip of recent days. It is wrong now
		   that Progress draws the plan end to end: on day 60 of 90 the
		   client would be shown a run of blank days for the first
		   month they actually filled in, and read it as lost work.

		   Bounded by the programme's own start rather than a number
		   here, so a ninety-day plan returns ninety days and a
		   thirty-day plan returns thirty. `started_on` is a column on
		   the programme, so the bound travels with the row instead of
		   being a constant two files away from the thing it limits. */
		rows, err := st.pool.Query(r.Context(), `
			SELECT DISTINCT ON (c.plan_item_id, c.on_date)
			       c.plan_item_id, to_char(c.on_date, 'YYYY-MM-DD'), c.state, c.note
			  FROM crm.checkins c
			  JOIN crm.programmes p ON p.id = c.programme_id
			 WHERE c.programme_id = $1
			   AND c.on_date >= p.started_on
			 ORDER BY c.plan_item_id, c.on_date, c.at DESC`, progID)
		if err != nil {
			bad(w, 500, "read_failed", "could not read that")
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var itemID, day, state, note string
			if err := rows.Scan(&itemID, &day, &state, &note); err != nil {
				continue
			}
			out = append(out, map[string]any{"itemId": itemID, "date": day, "state": state, "note": note})
		}
		writeJSON(w, 200, map[string]any{"ok": true, "checkins": out})
	}
}

/* POST /programme/{token}/checkin — PUBLIC, and it writes.

   APPEND-ONLY. There is no update path: a correction is a new row
   and the latest one for a day wins. Both stay, because a record
   somebody can quietly rewrite is not a record. */
func programmeCheckin(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		progID, personID, planNo, ok := st.programmeFor(r, r.PathValue("token"))
		if !ok {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}

		var in struct {
			ItemID string `json:"itemId"`
			OnDate string `json:"onDate"`
			State  string `json:"state"`
			Note   string `json:"note"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		switch in.State {
		case "done", "part", "skip":
		default:
			bad(w, 400, "invalid", "that is not an answer")
			return
		}

		/* TODAY, AND ONLY TODAY.
		   A check-in is a record of what somebody did today. Let them
		   fill in last Tuesday and it stops being a record and becomes
		   a memory test, which is worth nothing to her and worse than
		   nothing if she plans around it. A day that was missed stays
		   missed, and stays readable.

		   THE TOLERANCE IS ±1 DAY, and it is a timezone allowance
		   rather than a backfill window. This clock is UTC; a client
		   in Kolkata at half past midnight is still on yesterday's UTC
		   date, and one in Honolulu is a day behind. Every inhabited
		   offset falls inside ±14 hours, so ±1 calendar day covers all
		   of them and opens nothing — the app only ever sends its own
		   today. */
		day, err := time.Parse("2006-01-02", in.OnDate)
		if err != nil {
			bad(w, 400, "invalid", "that is not a date")
			return
		}
		today := time.Now().UTC().Truncate(24 * time.Hour)
		if day.After(today.AddDate(0, 0, 1)) || day.Before(today.AddDate(0, 0, -1)) {
			bad(w, 400, "out_of_range", "you can only fill in today")
			return
		}

		/* AND THE ITEM MUST BE THEIRS. Confirmed, on the current
		   issued version of the plan this programme points at. A
		   token holder cannot tick a row belonging to somebody
		   else's plan by guessing an id. */
		var okItem bool
		_ = st.pool.QueryRow(r.Context(), `
			SELECT EXISTS (
			  SELECT 1 FROM crm.plan_items i
			   WHERE i.id = $1
			     AND i.status IN ('confirmed', 'edited')
			     AND i.plan_id = (
			           SELECT id FROM crm.plans
			            WHERE person_id = $2 AND plan_no = $3 AND status = 'issued'
			            ORDER BY amendment DESC LIMIT 1))`,
			in.ItemID, personID, planNo).Scan(&okItem)
		if !okItem {
			bad(w, 404, "not_found", "that is not on your plan")
			return
		}

		note := strings.TrimSpace(in.Note)
		if len(note) > 500 {
			note = note[:500]
		}

		/* The id comes back, because a photograph is attached to a
		   check-in and the app has to know which one it just made. */
		var id string
		if err := st.pool.QueryRow(r.Context(), `
			INSERT INTO crm.checkins (programme_id, plan_item_id, on_date, state, note)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id`,
			progID, in.ItemID, day, in.State, note).Scan(&id); err != nil {
			bad(w, 500, "not_saved", "could not save that")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true, "checkinId": id})
	}
}

/* POST /programme/{token}/weight — PUBLIC, and it writes.

   Into crm.measurements, beside the ones she took, with source
   'self' so a curve never silently mixes a bathroom scale with a
   clinic one. */
func programmeWeight(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		progID, personID, _, ok := st.programmeFor(r, r.PathValue("token"))
		if !ok {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}

		var in struct {
			Kg float64 `json:"kg"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		/* Bounds, so a slipped decimal point does not put a 6.5 kg
		   adult on her curve and make the whole chart unreadable. */
		if in.Kg < 20 || in.Kg > 400 {
			bad(w, 400, "out_of_range", "that does not look like a weight")
			return
		}

		/* `weight`, and it used to be `weight_kg`. Nothing that read
		   weights back ever looked for the second name, so every
		   weight typed into this app went into the database and onto
		   no screen. See migration 0007. */
		if _, err := st.pool.Exec(r.Context(), `
			INSERT INTO crm.measurements
			  (person_id, kind, metric, value, unit, method, source, programme_id)
			VALUES ($1, 'body', 'weight', $2, 'kg', 'Self-reported', 'self', $3)`,
			personID, in.Kg, progID); err != nil {
			bad(w, 500, "not_saved", "could not save that")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true})
	}
}
