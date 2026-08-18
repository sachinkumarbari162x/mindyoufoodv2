/*
============================================================

	CLIENT ACCOUNT — everything the panel draws, in one read
	------------------------------------------------------------
	The panel has nine screens and no back end of its own. This
	file is that back end, and it answers in ONE request rather
	than nine, for a plain reason: on a phone on Indian mobile
	data, nine round trips is nine chances to see a spinner, and
	the screens are not independent anyway — Diet needs the plan
	items, Plan needs the same plan, Sessions needs the same
	consultations Account counts.

	EVERY READ HERE RUNS INSIDE asClient. That is not decoration.
	The queries below have WHERE clauses, and if one of them were
	deleted tomorrow the query would still return this person's
	rows and nobody else's, because row-level security is deciding
	and not the SQL. Anything that cannot run under RLS — resolving
	the session token, for one — happens before the transaction
	opens, in client_auth.go, and is the only thing that does.

	WHAT NEVER LEAVES THIS SERVICE
	  · the person's id. The browser is given a name and a plan;
	    it is never given a key to anything.
	  · plans.private_note — her clinical note to herself.
	  · documents where visible_to_client is false.
	  · anything belonging to a payment except the amount, the
	    date and the receipt number.
	The first is enforced by not selecting it, the rest by the
	policies in schema.sql.

	ROUTES (service-token protected; the BFF holds the cookie)
	  GET  /client/me        the whole panel
	  POST /client/checkin   a tick on one plan line
	  POST /client/review    asking to be seen again
	============================================================
*/
package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

/*
============================================================

	THE CLIENT ROUTES DO NOT RUN WITHOUT ROW-LEVEL SECURITY
	------------------------------------------------------------
	Read the queries below and notice what most of them do NOT
	have: a person in the WHERE clause.

	    SELECT id, ref, body, targets, issued_at
	      FROM crm.plans
	     WHERE status = 'issued'
	     ORDER BY plan_no DESC, amendment DESC LIMIT 1

	That is deliberate and it is safe for exactly one reason: it
	runs inside asClient, on a connection whose role is subject to
	the policies in schema.sql, with app.person_id set. Row-level
	security is what makes it return THEIR plan.

	With RLS off it returns the most recently issued plan in the
	practice — somebody else's — and the same is true of the
	documents, the receipts, the labs and the goals.

	AND RLS IS OFF BY DEFAULT. When DATABASE_URL_CLIENT is unset,
	Store.client is the OWNER pool (see store.go), and an owner
	bypasses every policy. That fallback is right for the CRM,
	which filters explicitly and has always run as the owner. It is
	catastrophic here.

	A deployment that forgets one environment variable would
	therefore serve every client every other client's health
	record, silently, with no error anywhere. That is not a thing
	to write in a runbook and hope. These routes refuse to answer
	instead.

	The message says what is wrong, because the person who sees it
	is the one who can fix it, and "unavailable" would send them
	looking at the wrong thing for an afternoon.
	============================================================
*/
func clientGuard(st *Store, w http.ResponseWriter) bool {
	if st.RLS() {
		return true
	}
	bad(w, 503, "rls_required",
		"the client app is not available on this server: DATABASE_URL_CLIENT is not set, "+
			"so a client's requests would not be scoped to that client")
	return false
}

/* ---- the read ------------------------------------------------- */

// GET /client/me
func clientMe(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !clientGuard(st, w) {
			return
		}
		personID, scope, ok := st.clientSession(r, clientToken(r))
		if !ok {
			bad(w, 401, "no_session", "please sign in again")
			return
		}

		/* HOW THEY GOT IN DECIDES WHAT THEY SEE.

		   A session opened by a token in a URL — /me/<token>, the
		   link in their pocket — is `programme`. It gets the plan
		   and the day, which is what somebody wants at breakfast,
		   and it does NOT get the receipts, the lab results, the
		   documents or the phone number. A link that is forwarded
		   in WhatsApp or left in a browser on a shared laptop must
		   not be a key to all of that.

		   THIS IS THE ENFORCEMENT. The panel hides those screens
		   too, but hiding a screen is a courtesy; the payload
		   simply not containing the data is the actual control. */
		full := scope != "programme"

		out := map[string]any{"ok": true, "scope": scope}
		ctx := r.Context()

		err := st.asClient(ctx, personID, func(tx pgx.Tx) error {
			/* ---- who they are ---------------------------------- */
			var name, email string
			var phone *string
			var since time.Time
			if err := tx.QueryRow(ctx, `
				SELECT name, email, phone, created_at
				  FROM crm.people WHERE id = crm.current_person()`).
				Scan(&name, &email, &phone, &since); err != nil {
				return err
			}
			/* On a token session, the name is all they get — enough
			   to say hello, and nothing anybody could use. */
			if full {
				out["person"] = map[string]any{
					"name": name, "firstName": firstWord(name), "email": email,
					"phone": phone, "since": since.UTC().Format(time.RFC3339),
				}
			} else {
				out["person"] = map[string]any{
					"name": name, "firstName": firstWord(name),
				}
			}

			/* ---- the programme, and what is left of it ---------
			   The panel prints days remaining, and this is where
			   that number is decided — once, in Postgres, against
			   the database's own idea of today. Working it out in
			   the browser makes it a function of the phone's clock,
			   and phones are wrong. */
			var progID, progStatus string
			var startedOn, endsOn time.Time
			var lengthDays, daysLeft int
			var planNo int
			progErr := tx.QueryRow(ctx, `
				SELECT id, status, plan_no, started_on,
				       COALESCE(ends_on, started_on + length_days),
				       length_days,
				       GREATEST(COALESCE(ends_on, started_on + length_days) - current_date, 0)
				  FROM crm.programmes
				 WHERE status = 'active'
				 ORDER BY started_on DESC LIMIT 1`).
				Scan(&progID, &progStatus, &planNo, &startedOn, &endsOn, &lengthDays, &daysLeft)

			if progErr == nil {
				/* RUNNING OUT IS NOT THE SAME AS BEING OVER, and the
				   panel has to say which. Rajat's sixty days are
				   behind him while his account is not: `expired` is
				   true, `status` is still active, and the copy on
				   screen is about renewing rather than about being
				   locked out. */
				out["programme"] = map[string]any{
					"status":     progStatus,
					"startedOn":  startedOn.Format("2006-01-02"),
					"endsOn":     endsOn.Format("2006-01-02"),
					"lengthDays": lengthDays,
					"daysLeft":   daysLeft,
					"expired":    daysLeft == 0 && endsOn.Before(time.Now()),
				}
			} else {
				out["programme"] = nil
			}

			/* ---- the plan --------------------------------------
			   The CURRENT issued amendment, never a draft and never
			   a superseded one. She corrects a plan because the old
			   one was wrong, and the person following it moves with
			   the correction. */
			var planID, planRef, planBody string
			var targets []byte
			var issuedAt *time.Time
			planErr := tx.QueryRow(ctx, `
				SELECT id, ref, body, targets, issued_at
				  FROM crm.plans
				 WHERE status = 'issued'
				 ORDER BY plan_no DESC, amendment DESC LIMIT 1`).
				Scan(&planID, &planRef, &planBody, &targets, &issuedAt)

			if planErr == nil {
				out["plan"] = map[string]any{
					"ref":      planRef,
					"sections": planSections(planBody),
					"targets":  raw(targets),
					"issuedAt": ts(issuedAt),
				}

				/* ---- the lines they tick ---------------------
				   CONFIRMED ONLY. A `proposed` row is a model's
				   guess she has not ruled on, and a client's app is
				   the last place one should appear. */
				rows, err := tx.Query(ctx, `
					SELECT id, seq, kind, label, quantity, unit, schedule, detail
					  FROM crm.plan_items
					 WHERE plan_id = $1 AND status IN ('confirmed','edited')
					 ORDER BY seq`, planID)
				if err != nil {
					return err
				}
				defer rows.Close()

				items := []map[string]any{}
				for rows.Next() {
					var id, kind, label, unit, schedule string
					var seq int
					var qty *float64
					var detail []byte
					if err := rows.Scan(&id, &seq, &kind, &label, &qty, &unit, &schedule, &detail); err != nil {
						continue
					}
					items = append(items, map[string]any{
						"id": id, "seq": seq, "kind": kind, "label": label,
						"quantity": qty, "unit": unit, "schedule": schedule,
						"detail": raw(detail),
					})
				}
				out["items"] = items
			} else {
				out["plan"] = nil
				out["items"] = []map[string]any{}
			}

			/* ---- what they have already ticked, today ----------
			   Today only. The whole history is a separate request
			   the Progress screen makes when it is opened, because
			   ninety days of ticks is the largest thing in this
			   payload and eight of the nine screens do not want it. */
			out["today"] = map[string]any{}
			if progErr == nil {
				rows, err := tx.Query(ctx, `
					SELECT plan_item_id, state, note
					  FROM crm.checkins
					 WHERE programme_id = $1 AND on_date = current_date`, progID)
				if err != nil {
					return err
				}
				defer rows.Close()
				today := map[string]any{}
				for rows.Next() {
					var itemID, state, note string
					if err := rows.Scan(&itemID, &state, &note); err != nil {
						continue
					}
					today[itemID] = map[string]any{"state": state, "note": note}
				}
				out["today"] = today
			}

			/* ---- the calendar ----------------------------------
			   Every day of the programme they ticked something on,
			   counted in Postgres rather than shipped as raw rows.

			   COUNTED, NOT LISTED. Ninety days of a fifteen-line
			   plan is thirteen hundred check-in rows; the calendar
			   draws one figure per day, so sending the rows would
			   be a megabyte of payload to render ninety numbers.
			   Days with nothing on them are simply absent — the
			   panel knows the programme's own start and end and
			   fills the gaps, which is also what makes an empty day
			   render as empty rather than as missing.

			   BOUNDED BY THE PROGRAMME, not by a rolling window. A
			   client on day 80 of 90 scrolling back to their first
			   week must find it there. */
			out["days"] = []map[string]any{}
			if progErr == nil {
				crows, err := tx.Query(ctx, `
					SELECT on_date,
					       count(*) FILTER (WHERE state = 'done') AS done,
					       count(*) FILTER (WHERE state = 'part') AS part,
					       count(*) FILTER (WHERE state = 'skip') AS skip
					  FROM crm.checkins
					 WHERE programme_id = $1
					 GROUP BY on_date
					 ORDER BY on_date`, progID)
				if err != nil {
					return err
				}
				defer crows.Close()
				days := []map[string]any{}
				for crows.Next() {
					var on time.Time
					var done, part, skip int
					if err := crows.Scan(&on, &done, &part, &skip); err != nil {
						continue
					}
					days = append(days, map[string]any{
						"on": on.Format("2006-01-02"), "done": done, "part": part, "skip": skip,
					})
				}
				out["days"] = days
			}

			/* ---- sessions -------------------------------------- */
			rows, err := tx.Query(ctx, `
				SELECT id, issue, mode, status, scheduled_start_at, scheduled_end_at
				  FROM crm.consultations
				 WHERE status IN ('held','confirmed','completed')
				 ORDER BY scheduled_start_at DESC NULLS LAST`)
			if err != nil {
				return err
			}
			defer rows.Close()

			upcoming := []map[string]any{}
			past := []map[string]any{}
			for rows.Next() {
				var id, issue, mode, status string
				var start, end *time.Time
				if err := rows.Scan(&id, &issue, &mode, &status, &start, &end); err != nil {
					continue
				}
				mins := 0
				if start != nil && end != nil {
					mins = int(end.Sub(*start).Minutes())
				}
				one := map[string]any{
					"issue": issue, "mode": mode, "status": status,
					"startsAt": ts(start), "minutes": mins,
				}
				/* Split by the clock, not by status. A `confirmed`
				   hour that was yesterday and never marked completed
				   is in the past whatever the row says, and putting
				   it under NEXT SESSION would be the panel telling a
				   plain lie. */
				if start != nil && start.After(time.Now()) && status != "completed" {
					upcoming = append(upcoming, one)
				} else {
					past = append(past, one)
				}
			}
			// Soonest first: the next one is the one being asked about.
			for i, j := 0, len(upcoming)-1; i < j; i, j = i+1, j-1 {
				upcoming[i], upcoming[j] = upcoming[j], upcoming[i]
			}
			out["upcoming"] = upcoming
			out["past"] = past

			/* ---- documents ------------------------------------
			   The policy has already withheld anything not marked
			   visible; the ids here are document ids, which are
			   good for exactly one thing — asking this service for
			   that file, which asks RLS the same question again. */
			/* NOT FETCHED AT ALL on a token session, rather than
			   fetched and filtered. A query that never runs cannot
			   be made to leak by a later edit that forgets why the
			   filter was there. */
			out["documents"] = []map[string]any{}
			out["receipts"] = []map[string]any{}
			out["labs"] = []map[string]any{}
			out["goals"] = []map[string]any{}

			/* THE SENSITIVE BLOCK, and the guard wraps exactly it.

			   Documents, receipts, lab results and the goals that
			   name them. Everything after this block — the sleep and
			   weight the client typed in themselves — is programme
			   data and stays, because the old /me/ app showed it and
			   folding the apps together must not take it away.

			   An early `return nil` here was the first attempt and it
			   was wrong: it skipped the two charts as well, which is
			   how a security guard quietly becomes a missing
			   feature. */
			if full {

				drows, err := tx.Query(ctx, `
				SELECT id, kind, title, mime, bytes, uploaded_by, uploaded_at
				  FROM crm.documents ORDER BY uploaded_at DESC`)
				if err != nil {
					return err
				}
				defer drows.Close()
				docs := []map[string]any{}
				for drows.Next() {
					var id, kind, title, mime, by string
					var bytesN int
					var at time.Time
					if err := drows.Scan(&id, &kind, &title, &mime, &bytesN, &by, &at); err != nil {
						continue
					}
					docs = append(docs, map[string]any{
						"id": id, "kind": kind, "title": title, "mime": mime,
						"bytes": bytesN, "uploadedBy": by,
						"uploadedAt": at.UTC().Format(time.RFC3339),
					})
				}
				out["documents"] = docs

				/* ---- receipts -------------------------------------- */
				irows, err := tx.Query(ctx, `
				SELECT number, description, currency, amount_minor, issued_at
				  FROM crm.invoices ORDER BY issued_at DESC`)
				if err != nil {
					return err
				}
				defer irows.Close()
				receipts := []map[string]any{}
				for irows.Next() {
					var number, description, currency string
					var minor int64
					var at time.Time
					if err := irows.Scan(&number, &description, &currency, &minor, &at); err != nil {
						continue
					}
					receipts = append(receipts, map[string]any{
						"number": number, "description": description,
						"currency": currency, "amountMinor": minor,
						"issuedAt": at.UTC().Format(time.RFC3339),
					})
				}
				out["receipts"] = receipts

				/* ---- labs they can read ---------------------------
				   With the reference range beside them, because a
				   number alone at one in the morning is a search
				   engine and a bad night. */
				mrows, err := tx.Query(ctx, `
				SELECT metric, value, unit, ref_low, ref_high, taken_at
				  FROM crm.measurements
				 WHERE kind = 'lab' ORDER BY taken_at DESC LIMIT 20`)
				if err != nil {
					return err
				}
				defer mrows.Close()
				labs := []map[string]any{}
				for mrows.Next() {
					var metric, unit string
					var value float64
					var low, high *float64
					var at time.Time
					if err := mrows.Scan(&metric, &value, &unit, &low, &high, &at); err != nil {
						continue
					}
					band := "unknown"
					switch {
					case low != nil && value < *low:
						band = "below"
					case high != nil && value > *high:
						band = "above"
					case low != nil || high != nil:
						band = "within"
					}
					labs = append(labs, map[string]any{
						"metric": metric, "value": value, "unit": unit,
						"refLow": low, "refHigh": high, "band": band,
						"takenAt": at.UTC().Format(time.RFC3339),
					})
				}
				out["labs"] = labs
			}

			/* ---- the two lines the screens draw ----------------
			   Sleep for the week strip, weight for the trend. Small
			   enough to travel with everything else — fourteen
			   numbers — and the alternative is two more round trips
			   for two charts that are on screen at first paint.

			   SELF-REPORTED ONLY, and the panel says so. These are
			   what the client typed; her clinical measurements are a
			   different thing and are not mixed in with them. */
			out["sleep"] = []map[string]any{}
			out["weight"] = []map[string]any{}
			for _, series := range []struct {
				key, metric, kind string
				limit             int
			}{
				{"sleep", "hours", "sleep", 14},
				{"weight", "weight", "body", 20},
			} {
				srows, err := tx.Query(ctx, `
					SELECT taken_at, value FROM crm.measurements
					 WHERE kind = $1 AND metric = $2 AND source IN ('self','device')
					 ORDER BY taken_at DESC LIMIT $3`, series.kind, series.metric, series.limit)
				if err != nil {
					return err
				}
				points := []map[string]any{}
				for srows.Next() {
					var at time.Time
					var v float64
					if err := srows.Scan(&at, &v); err != nil {
						continue
					}
					// Oldest first, so a chart reads left to right
					// without the caller having to reverse it.
					points = append([]map[string]any{{
						"on": at.Format("2006-01-02"), "value": v,
					}}, points...)
				}
				srows.Close()
				out[series.key] = points
			}

			/* ---- goals -----------------------------------------
			   Withheld on a token session with the rest of the
			   clinical block. A goal names a lab target — "haemoglobin
			   above 12" — which says as much about somebody as the
			   result it refers to.

			   It sits down here rather than up with documents and
			   receipts only because that is the order the payload was
			   written in; the guard is what matters, not the
			   adjacency. Setting out["goals"] to empty above and then
			   filling it here unconditionally was the bug this
			   comment is standing on. */
			if !full {
				return nil
			}

			grows, err := tx.Query(ctx, `
				SELECT kind, goal, target_metric, target_value, due_on, status
				  FROM crm.goals WHERE status = 'active' ORDER BY created_at`)
			if err != nil {
				return err
			}
			defer grows.Close()
			goals := []map[string]any{}
			for grows.Next() {
				var kind, goal, status string
				var metric *string
				var target *float64
				var due *time.Time
				if err := grows.Scan(&kind, &goal, &metric, &target, &due, &status); err != nil {
					continue
				}
				var dueOn *string
				if due != nil {
					d := due.Format("2006-01-02")
					dueOn = &d
				}
				goals = append(goals, map[string]any{
					"kind": kind, "goal": goal, "metric": metric,
					"target": target, "dueOn": dueOn,
				})
			}
			out["goals"] = goals

			return nil
		})

		if err != nil {
			bad(w, 500, "read_failed", "could not open your account")
			return
		}

		/* ---- the questions ----------------------------------
		   OUTSIDE asClient, DELIBERATELY. These belong to the
		   practice and not to a person: the same six answers for
		   everybody, written by her in the CRM, filtered to the
		   `client` audience so the front desk's answers about
		   booking never appear on a client's screen and hers
		   never appear on a stranger's.

		   Nothing person-shaped is read here, so there is nothing
		   for row-level security to scope — and running it inside
		   the client transaction would need a grant on a table
		   that has no business being reachable from that role. */
		questions := []map[string]any{}
		if qrows, err := st.pool.Query(ctx, `
			SELECT label, answer FROM crm.knowledge
			 WHERE audience = 'client' AND active
			 ORDER BY label`); err == nil {
			for qrows.Next() {
				var label, answer string
				if err := qrows.Scan(&label, &answer); err != nil {
					continue
				}
				questions = append(questions, map[string]any{"q": label, "a": answer})
			}
			qrows.Close()
		}
		out["questions"] = questions

		writeJSON(w, 200, out)
	}
}

/* ---- the writes ----------------------------------------------- */

/*
POST /client/checkin  {itemId, state, note, date}

	A tick. Same shape as the programme link's checkin and the same
	bounds, except that the identity comes from a session rather
	than from a token in a URL. It runs inside asClient, so the
	INSERT's WITH CHECK is what stops a client writing a tick
	against somebody else's programme — the itemId cannot be
	borrowed.
*/
func clientCheckin(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !clientGuard(st, w) {
			return
		}
		personID, ok := st.clientFor(r, clientToken(r))
		if !ok {
			bad(w, 401, "no_session", "please sign in again")
			return
		}
		var in struct {
			ItemID string `json:"itemId"`
			State  string `json:"state"`
			Note   string `json:"note"`
			Date   string `json:"date"`
		}
		if err := decode(r, &in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.State != "done" && in.State != "part" && in.State != "skip" {
			bad(w, 400, "bad_state", "done, part or skip")
			return
		}
		note := strings.TrimSpace(in.Note)
		if len(note) > 500 {
			note = note[:500]
		}

		ctx := r.Context()
		var id string
		err := st.asClient(ctx, personID, func(tx pgx.Tx) error {
			/* THE DAY IS DECIDED HERE, not by the phone. A client in
			   a different timezone, or one whose clock is a day out,
			   would otherwise write ticks onto a date she then reads
			   as a missed day. current_date unless they explicitly
			   named a day, and even then only one inside the
			   programme. */
			day := "current_date"
			args := []any{in.ItemID, in.State, note}
			if in.Date != "" {
				day = "$4::date"
				args = append(args, in.Date)
			}

			/* AND THE LINE MUST BE ON THEIR OWN CURRENT PLAN.
			   Row-level security alone does not settle this: the
			   foreign key from checkins.plan_item_id is checked by
			   Postgres as the table's owner and so does not consult
			   any policy, which means a client could otherwise write
			   a tick against a plan_item id belonging to somebody
			   else. Joining plan_items into the INSERT is what
			   closes it — under RLS that join sees only their own
			   rows, so a borrowed id matches nothing, inserts
			   nothing, and returns nothing to scan.

			   Measured, not assumed: before this join, Aisha's
			   session successfully ticked a line off Sneha's plan. */
			return tx.QueryRow(ctx, `
				INSERT INTO crm.checkins (programme_id, plan_item_id, on_date, state, note)
				SELECT g.id, i.id, `+day+`, $2, $3
				  FROM crm.programmes g
				  JOIN crm.plan_items i
				    ON i.id = $1
				   AND i.status IN ('confirmed','edited')
				   AND i.plan_id = (SELECT id FROM crm.plans
				                     WHERE status = 'issued'
				                     ORDER BY plan_no DESC, amendment DESC LIMIT 1)
				 WHERE g.status = 'active'
				 ORDER BY g.started_on DESC LIMIT 1
				RETURNING id`, args...).Scan(&id)
		})
		if err != nil {
			bad(w, 404, "not_found", "that is not on your plan")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true, "checkinId": id})
	}
}

/*
POST /client/review  {note}

	Asking to be seen again. It writes a consultation with no time
	on it and `source = 'review'`, which is what puts it in front of
	her; SHE picks the hour and it is confirmed when it is paid for.
	The panel's copy says exactly that, and this endpoint is why it
	has to: nothing here books anything.
*/
func clientReviewAsk(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !clientGuard(st, w) {
			return
		}
		personID, ok := st.clientFor(r, clientToken(r))
		if !ok {
			bad(w, 401, "no_session", "please sign in again")
			return
		}
		var in struct {
			Note string `json:"note"`
		}
		_ = decode(r, &in)
		note := strings.TrimSpace(in.Note)
		if len(note) > 1000 {
			note = note[:1000]
		}
		issue := "Asked for another session"
		if note != "" {
			issue = note
		}

		ctx := r.Context()

		/* ONE OPEN REQUEST AT A TIME. Without this, a client who
		   taps twice — or reloads a page that posted — turns into
		   two rows she has to work out are the same person asking
		   the same thing. The panel disables its button too; this
		   is the half that survives a refresh. */
		var existing string
		_ = st.asClient(ctx, personID, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				SELECT id FROM crm.consultations
				 WHERE source = 'review' AND status = 'held'
				   AND scheduled_start_at IS NULL
				 LIMIT 1`).Scan(&existing)
		})
		if existing != "" {
			writeJSON(w, 200, map[string]any{"ok": true, "already": true})
			return
		}

		var id string
		err := st.asClient(ctx, personID, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `
				INSERT INTO crm.consultations (person_id, issue, status, source)
				VALUES (crm.current_person(), $1, 'held', 'review')
				RETURNING id`, issue).Scan(&id)
		})
		if err != nil {
			bad(w, 500, "not_saved", "could not send that")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true, "requestId": id})
	}
}

/* ---- the three the panel was missing ---------------------------
   The token app at /me/ has been able to record a weight, write a
   note against a day and attach a photograph since it was built.
   The account panel could do neither, which is why pointing /me/
   at it would have quietly taken three things away from every
   client using it.

   Same bounds as the token versions, same reasons, and all three
   run inside asClient so the programme is theirs by construction
   rather than because a caller said so. */

/* POST /client/weight  {kg} */
func clientWeight(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !clientGuard(st, w) {
			return
		}
		personID, ok := st.clientFor(r, clientToken(r))
		if !ok {
			bad(w, 401, "no_session", "please sign in again")
			return
		}

		var in struct {
			Kg float64 `json:"kg"`
		}
		if err := decode(r, &in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		/* Bounds, so a slipped decimal point does not put a 6.5 kg
		   adult on her curve and make the whole chart unreadable. */
		if in.Kg < 20 || in.Kg > 400 {
			bad(w, 400, "out_of_range", "that does not look like a weight")
			return
		}

		ctx := r.Context()
		err := st.asClient(ctx, personID, func(tx pgx.Tx) error {
			/* `weight`, NOT `weight_kg`. The token app wrote the
			   second name for months while the seed, the charts and
			   crm.metric_defs all used the first — so a weight a
			   client typed into /me/ never appeared on any screen
			   that read it back. Migration 0007 renames the old rows
			   and both endpoints now agree. The unit lives in the
			   unit column, which is where a unit belongs; it has no
			   business being half of the metric's name. */
			_, err := tx.Exec(ctx, `
				INSERT INTO crm.measurements
				  (person_id, kind, metric, value, unit, method, source, programme_id)
				SELECT crm.current_person(), 'body', 'weight', $1, 'kg', 'Self-reported', 'self', g.id
				  FROM crm.programmes g
				 WHERE g.status = 'active'
				 ORDER BY g.started_on DESC LIMIT 1`, in.Kg)
			return err
		})
		if err != nil {
			bad(w, 400, "not_saved", "could not save that")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true})
	}
}

/*
POST /client/note  {body, date}

	Something they wanted to say that no row on the plan has a box
	for — "ate out, had two chapatis instead". It is the richest
	thing in a review and the least prompted for.
*/
func clientNote(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !clientGuard(st, w) {
			return
		}
		personID, ok := st.clientFor(r, clientToken(r))
		if !ok {
			bad(w, 401, "no_session", "please sign in again")
			return
		}

		var in struct {
			Body string `json:"body"`
			Date string `json:"date"`
		}
		if err := decode(r, &in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		body := strings.TrimSpace(in.Body)
		if body == "" {
			bad(w, 400, "invalid", "there is nothing written in it")
			return
		}
		if len(body) > 2000 {
			body = body[:2000]
		}

		ctx := r.Context()
		var id string
		err := st.asClient(ctx, personID, func(tx pgx.Tx) error {
			/* The day is the database's, not the phone's — same rule
			   as a check-in, and for the same reason. */
			day := "current_date"
			args := []any{body}
			if in.Date != "" {
				day = "$2::date"
				args = append(args, in.Date)
			}
			return tx.QueryRow(ctx, `
				INSERT INTO crm.programme_notes (programme_id, on_date, body)
				SELECT g.id, `+day+`, $1
				  FROM crm.programmes g
				 WHERE g.status = 'active'
				 ORDER BY g.started_on DESC LIMIT 1
				RETURNING id`, args...).Scan(&id)
		})
		if err != nil {
			bad(w, 400, "not_saved", "could not save that")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true, "noteId": id})
	}
}

/*
POST /client/media  {checkinId, storageKey, mime, bytes, sha256, takenAt}

	The bytes never pass through this service — the BFF has already
	put them in storage and this records that one exists.
*/
func clientMedia(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !clientGuard(st, w) {
			return
		}
		personID, ok := st.clientFor(r, clientToken(r))
		if !ok {
			bad(w, 401, "no_session", "please sign in again")
			return
		}

		var in struct {
			CheckinID  string `json:"checkinId"`
			StorageKey string `json:"storageKey"`
			Mime       string `json:"mime"`
			Bytes      int    `json:"bytes"`
			Sha256     string `json:"sha256"`
			Width      *int   `json:"width"`
			Height     *int   `json:"height"`
			TakenAt    string `json:"takenAt"`
		}
		if err := decode(r, &in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.StorageKey == "" || in.Sha256 == "" || in.Bytes <= 0 {
			bad(w, 400, "invalid", "that is not a photo")
			return
		}

		taken := time.Now()
		if in.TakenAt != "" {
			if t, err := time.Parse(time.RFC3339, in.TakenAt); err == nil {
				/* A phone with a wrong clock must not be able to file
				   a photograph in the middle of last year. */
				if t.After(time.Now().AddDate(0, 0, -14)) && t.Before(time.Now().AddDate(0, 0, 1)) {
					taken = t
				}
			}
		}

		ctx := r.Context()
		var id string
		err := st.asClient(ctx, personID, func(tx pgx.Tx) error {
			/* THE SELECT IS THE PERMISSION CHECK. Under RLS the
			   checkins row is only visible if it is theirs, so a
			   guessed id inserts nothing rather than attaching a
			   photograph to a stranger's day. */
			return tx.QueryRow(ctx, `
				INSERT INTO crm.checkin_media
				  (checkin_id, storage_key, mime, bytes, sha256, width, height, taken_at)
				SELECT c.id, $2, $3, $4, $5, $6, $7, $8
				  FROM crm.checkins c
				 WHERE c.id = $1
				RETURNING id`,
				in.CheckinID, in.StorageKey, in.Mime, in.Bytes, in.Sha256,
				in.Width, in.Height, taken).Scan(&id)
		})
		if err != nil {
			bad(w, 404, "not_found", "that is not one of your days")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true, "id": id})
	}
}

/* ---- helpers -------------------------------------------------- */

/*
Her prose, split into the sections the Plan screen renders.

	"## " starts a section and everything until the next one is its
	body. A plan with no headings comes back as a single untitled
	section rather than as nothing, because a plan she typed in one
	paragraph is still a plan and the screen must show it.
*/
func planSections(body string) []map[string]string {
	out := []map[string]string{}
	if strings.TrimSpace(body) == "" {
		return out
	}
	var title string
	var buf []string
	flush := func() {
		text := strings.TrimSpace(strings.Join(buf, "\n"))
		if title == "" && text == "" {
			return
		}
		out = append(out, map[string]string{"title": title, "body": text})
		buf = nil
	}
	for _, line := range strings.Split(body, "\n") {
		if strings.HasPrefix(line, "## ") {
			flush()
			title = strings.TrimSpace(strings.TrimPrefix(line, "## "))
			continue
		}
		buf = append(buf, line)
	}
	flush()
	return out
}

/*
A jsonb column straight through to the client without Go having

	to know its shape. Bad or empty JSON becomes an empty object,
	never null — the panel reads `detail.meal` without checking, and
	it should not have to.
*/
func raw(b []byte) any {
	if len(b) == 0 {
		return map[string]any{}
	}
	var v any
	if err := json.Unmarshal(b, &v); err != nil || v == nil {
		return map[string]any{}
	}
	return v
}
