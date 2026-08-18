// Programme monitor — HER read of somebody's daily record
//
//	GET /crm/programme/days?programmeId=&days=   every day, every row
//	GET /crm/programme/weights?programmeId=      what the app weighed
//
// THE CLIENT'S OWN ROUTES CANNOT SERVE THIS. /programme/{token}/days
// is scoped by a token she does not hold and must not hold — the
// token is the client's credential, returned once when the programme
// started and never listed again. So her view is a separate pair of
// routes behind her session, reading the same rows by programme id.
//
// WHY THIS IS NOT crmAdherence. Adherence is a TALLY — eleven done,
// two skipped, over a window. That answers "how is it going" and
// cannot answer "what happened on the fourth". This returns the rows
// themselves, which is what a record is.
//
// CORRECTIONS ARE COUNTED, NOT HIDDEN. A check-in is append-only: a
// client who fixes a mistake writes a second row and the latest wins.
// The latest is what comes back, with `revisions` saying how many
// there were — so a day somebody changed their mind about is visible
// as exactly that, rather than looking like a day they got right
// first time.
package main

import (
	"net/http"
	"time"
)

/* GET /crm/programme/days?programmeId=&days=

   One row per item per day — the latest, by the rule above. Joined to
   the plan item so the label travels with it: she is reading "Walk,
   30 minutes", not a uuid. */
func crmProgrammeDays(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("programmeId")
		if id == "" {
			bad(w, 400, "invalid", "a programme is needed")
			return
		}
		days := clampInt(r.URL.Query().Get("days"), 35, 1, 400)

		rows, err := st.pool.Query(r.Context(), `
			SELECT DISTINCT ON (c.plan_item_id, c.on_date)
			       c.id, c.plan_item_id, i.label, i.kind, i.seq,
			       to_char(c.on_date, 'YYYY-MM-DD'), c.state, c.note, c.at,
			       COUNT(*) OVER (PARTITION BY c.plan_item_id, c.on_date)
			  FROM crm.checkins c
			  JOIN crm.plan_items i ON i.id = c.plan_item_id
			 WHERE c.programme_id = $1
			   AND c.on_date > current_date - $2::int
			 ORDER BY c.plan_item_id, c.on_date, c.at DESC`, id, days)
		if err != nil {
			bad(w, 500, "read_failed", "could not read those")
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var cid, itemID, label, kind, day, state, note string
			var seq, revisions int
			var at time.Time
			if err := rows.Scan(&cid, &itemID, &label, &kind, &seq,
				&day, &state, &note, &at, &revisions); err != nil {
				continue
			}
			out = append(out, map[string]any{
				"checkinId": cid, "itemId": itemID, "label": label, "kind": kind,
				"seq": seq, "date": day, "state": state, "note": note,
				"at": at.Format(time.RFC3339), "revisions": revisions,
			})
		}
		writeJSON(w, 200, map[string]any{"ok": true, "checkins": out})
	}
}

/* GET /crm/programme/weights?programmeId=

   Only what came through THIS programme — source 'self', stamped with
   the programme id when the app sent it. Her own clinic weights are
   on the assessment where they belong; a curve that silently mixes a
   bathroom scale with a calibrated one is a curve that lies. */
func crmProgrammeWeights(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("programmeId")
		if id == "" {
			bad(w, 400, "invalid", "a programme is needed")
			return
		}

		/* `weight`, and it was `weight_kg` in two places — this one
		   and programme_progress.go — while the seed, the client
		   panel and crm.metric_defs all used `weight`. Renaming the
		   rows in migration 0007 without these two would have left
		   HER chart empty, which is the sort of thing that is only
		   noticed weeks later by somebody wondering where a client's
		   progress went. */
		rows, err := st.pool.Query(r.Context(), `
			SELECT value, unit, taken_at
			  FROM crm.measurements
			 WHERE programme_id = $1 AND metric = 'weight'
			 ORDER BY taken_at`, id)
		if err != nil {
			bad(w, 500, "read_failed", "could not read those")
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var kg float64
			var unit string
			var at time.Time
			if err := rows.Scan(&kg, &unit, &at); err != nil {
				continue
			}
			out = append(out, map[string]any{
				"kg": kg, "unit": unit, "at": at.Format(time.RFC3339),
				"date": at.Format("2006-01-02"),
			})
		}
		writeJSON(w, 200, map[string]any{"ok": true, "weights": out})
	}
}
