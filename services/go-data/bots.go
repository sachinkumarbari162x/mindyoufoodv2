// Bot turns and switches — measurement, and the master panel's on/off
//
//	POST /crm/bot-turns         record one turn
//	GET  /crm/bot-turns         read them back, newest first
//	GET  /crm/bot-turns/stats   the counts the panel actually shows
//	GET  /crm/bot-switches      which bots are on
//	POST /crm/bot-switches      turn one on or off
//
// The write path is deliberately the cheapest thing here: it is
// called on every single turn of every conversation, and a log that
// can slow down the desk it is logging is worse than no log.
package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

// POST /crm/bot-turns
func crmBotTurnAdd(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Bot        string   `json:"bot"`
			Lane       string   `json:"lane"`
			SessionRef *string  `json:"sessionRef"`
			Input      *string  `json:"input"`
			Output     *string  `json:"output"`
			Intent     *string  `json:"intent"`
			Confidence *float64 `json:"confidence"`
			Reason     *string  `json:"reason"`
			Model      *string  `json:"model"`
			LatencyMs  int      `json:"latencyMs"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.Bot == "" {
			bad(w, 400, "invalid", "a turn needs a bot")
			return
		}
		if in.Lane != "deterministic" && in.Lane != "agentic" {
			bad(w, 400, "invalid", "lane must be deterministic or agentic")
			return
		}

		_, err := st.pool.Exec(r.Context(), `
			INSERT INTO crm.bot_turns
			  (bot, lane, session_ref, input, output, intent, confidence, reason, model, latency_ms)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
			in.Bot, in.Lane, in.SessionRef, in.Input, in.Output,
			in.Intent, in.Confidence, in.Reason, in.Model, in.LatencyMs)
		if err != nil {
			bad(w, 500, "write_failed", "could not record that turn")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true})
	}
}

// GET /crm/bot-turns?limit=&bot=&lane=
func crmBotTurnList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := 100
		if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 500 {
			limit = n
		}

		rows, err := st.pool.Query(r.Context(), `
			SELECT id, at, bot, lane, COALESCE(session_ref,''),
			       COALESCE(input,''), COALESCE(output,''),
			       COALESCE(intent,''), COALESCE(confidence,0),
			       COALESCE(reason,''), COALESCE(model,''), latency_ms,
			       redacted_at IS NOT NULL
			  FROM crm.bot_turns
			 WHERE ($1 = '' OR bot = $1) AND ($2 = '' OR lane = $2)
			 ORDER BY at DESC, id DESC
			 LIMIT $3`,
			r.URL.Query().Get("bot"), r.URL.Query().Get("lane"), limit)
		if err != nil {
			bad(w, 500, "read_failed", "could not read the turns")
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var id int64
			var at time.Time
			var bot, lane, ref, in, outp, intent, reason, model string
			var conf float64
			var latency int
			var redacted bool
			if err := rows.Scan(&id, &at, &bot, &lane, &ref, &in, &outp,
				&intent, &conf, &reason, &model, &latency, &redacted); err != nil {
				continue
			}
			out = append(out, map[string]any{
				"id": id, "at": at.Format(time.RFC3339), "bot": bot, "lane": lane,
				"sessionRef": ref, "input": in, "output": outp,
				"intent": intent, "confidence": conf, "reason": reason,
				"model": model, "latencyMs": latency, "redacted": redacted,
			})
		}
		writeJSON(w, 200, map[string]any{"ok": true, "turns": out})
	}
}

// GET /crm/bot-turns/stats
//
// The numbers the panel is actually for: how much of the work the
// deterministic lane is carrying, and what it costs when it does not.
func crmBotStats(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := st.pool.Query(r.Context(), `
			SELECT bot, lane,
			       count(*)                              AS turns,
			       COALESCE(round(avg(latency_ms))::int, 0) AS avg_ms,
			       COALESCE(max(latency_ms), 0)          AS max_ms
			  FROM crm.bot_turns
			 WHERE at > now() - interval '30 days'
			 GROUP BY bot, lane
			 ORDER BY turns DESC`)
		if err != nil {
			bad(w, 500, "read_failed", "could not read the counts")
			return
		}
		defer rows.Close()

		stats := []map[string]any{}
		for rows.Next() {
			var bot, lane string
			var turns, avgMs, maxMs int
			if err := rows.Scan(&bot, &lane, &turns, &avgMs, &maxMs); err != nil {
				continue
			}
			stats = append(stats, map[string]any{
				"bot": bot, "lane": lane, "turns": turns,
				"avgMs": avgMs, "maxMs": maxMs,
			})
		}

		// Why the orchestrator chose what it chose, which is the
		// closest thing here to a verdict on the deterministic lane.
		reasons := map[string]int{}
		rrows, err := st.pool.Query(r.Context(), `
			SELECT COALESCE(reason,'unknown'), count(*)
			  FROM crm.bot_turns
			 WHERE at > now() - interval '30 days'
			 GROUP BY 1 ORDER BY 2 DESC`)
		if err == nil {
			defer rrows.Close()
			for rrows.Next() {
				var reason string
				var n int
				if err := rrows.Scan(&reason, &n); err == nil {
					reasons[reason] = n
				}
			}
		}

		writeJSON(w, 200, map[string]any{"ok": true, "stats": stats, "reasons": reasons})
	}
}

// GET /crm/bot-switches
func crmBotSwitchList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := st.pool.Query(r.Context(),
			`SELECT bot, enabled, COALESCE(note,''), changed_at FROM crm.bot_switches ORDER BY bot`)
		if err != nil {
			bad(w, 500, "read_failed", "could not read the switches")
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var bot, note string
			var enabled bool
			var changed time.Time
			if err := rows.Scan(&bot, &enabled, &note, &changed); err != nil {
				continue
			}
			out = append(out, map[string]any{
				"bot": bot, "enabled": enabled, "note": note,
				"changedAt": changed.Format(time.RFC3339),
			})
		}
		writeJSON(w, 200, map[string]any{"ok": true, "switches": out})
	}
}

// POST /crm/bot-switches
func crmBotSwitchSet(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Bot     string `json:"bot"`
			Enabled *bool  `json:"enabled"`
			Note    string `json:"note"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.Bot == "" || in.Enabled == nil {
			bad(w, 400, "invalid", "which bot, and on or off?")
			return
		}

		_, err := st.pool.Exec(r.Context(), `
			INSERT INTO crm.bot_switches (bot, enabled, note, changed_at)
			VALUES ($1, $2, NULLIF($3,''), now())
			ON CONFLICT (bot) DO UPDATE
			  SET enabled = EXCLUDED.enabled,
			      note = EXCLUDED.note,
			      changed_at = now()`,
			in.Bot, *in.Enabled, in.Note)
		if err != nil {
			bad(w, 500, "write_failed", "could not save that")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}
