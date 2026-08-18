// The consultation room, remembered
//
//	POST /crm/rooms/join    somebody arrived on one side
//	POST /crm/rooms/state    waiting -> live -> ended
//	POST /crm/rooms/leave    they went, and how the media had travelled
//	GET  /crm/rooms          what has happened lately
//
// The SSE connections themselves stay in memory in the BFF, because
// an open HTTP response is not a thing a database can hold. What
// goes here are the FACTS: who joined, when, who started it, whether
// the media got through, and when it ended.
package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

// POST /crm/rooms/join
func crmRoomJoin(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Room           string  `json:"room"`
			Side           string  `json:"side"`
			ConsultationID *string `json:"consultationId"`
			UserAgent      string  `json:"userAgent"`
			IPHash         string  `json:"ipHash"`
			Source         string  `json:"source"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.Room == "" || (in.Side != "host" && in.Side != "client") {
			bad(w, 400, "invalid", "a room and a side are needed")
			return
		}
		if in.Source != "trial" {
			in.Source = "system"
		}

		ctx := r.Context()
		tx, err := st.pool.Begin(ctx)
		if err != nil {
			bad(w, 500, "busy", "could not record that")
			return
		}
		defer tx.Rollback(ctx) //nolint:errcheck

		/* Find the open session for this room, or open one. The
		   partial unique index is what makes this safe under two
		   arrivals at the same instant: the second insert loses and
		   falls through to the select. */
		var sessionID, state string
		err = tx.QueryRow(ctx, `
			SELECT id, state FROM crm.room_sessions
			 WHERE room = $1 AND state <> 'ended'`, in.Room).Scan(&sessionID, &state)

		if err != nil {
			err = tx.QueryRow(ctx, `
				INSERT INTO crm.room_sessions (room, consultation_id, state, source)
				VALUES ($1, $2, 'waiting', $3)
				ON CONFLICT (room) WHERE state <> 'ended'
				DO UPDATE SET room = EXCLUDED.room
				RETURNING id, state`,
				in.Room, in.ConsultationID, in.Source).Scan(&sessionID, &state)
			if err != nil {
				bad(w, 500, "not_opened", "could not open that room")
				return
			}
		}

		/* A reconnect closes the previous presence rather than
		   colliding with it. Three drops on a train read as three
		   joins by one person, which is the truth, instead of as a
		   constraint violation. */
		_, _ = tx.Exec(ctx, `
			UPDATE crm.room_participants
			   SET left_at = now()
			 WHERE session_id = $1 AND side = $2 AND left_at IS NULL`,
			sessionID, in.Side)

		var participantID string
		err = tx.QueryRow(ctx, `
			INSERT INTO crm.room_participants (session_id, side, user_agent, ip_hash)
			VALUES ($1, $2, NULLIF($3,''), NULLIF($4,''))
			RETURNING id`,
			sessionID, in.Side, truncate(in.UserAgent, 300), in.IPHash).Scan(&participantID)
		if err != nil {
			bad(w, 500, "not_joined", "could not record that arrival")
			return
		}

		if err := tx.Commit(ctx); err != nil {
			bad(w, 500, "not_saved", "could not record that arrival")
			return
		}

		writeJSON(w, 200, map[string]any{
			"ok": true, "sessionId": sessionID, "participantId": participantID, "state": state,
		})
	}
}

// POST /crm/rooms/state — the transition, and who made it
func crmRoomState(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Room  string `json:"room"`
			State string `json:"state"`
			By    string `json:"by"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.State != "live" && in.State != "ended" {
			bad(w, 400, "invalid", "state must be live or ended")
			return
		}

		/* started_at is set once and never moved; ended_at only on
		   the way out. A session that went live, dropped and came
		   back keeps the hour it actually began. */
		ct, err := st.pool.Exec(r.Context(), `
			UPDATE crm.room_sessions
			   SET state      = $2,
			       started_at = CASE WHEN $2 = 'live'  AND started_at IS NULL
			                         THEN now() ELSE started_at END,
			       started_by = CASE WHEN $2 = 'live'  AND started_by IS NULL
			                         THEN NULLIF($3,'') ELSE started_by END,
			       ended_at   = CASE WHEN $2 = 'ended' THEN now() ELSE ended_at END
			 WHERE room = $1 AND state <> 'ended'`,
			in.Room, in.State, in.By)
		if err != nil {
			bad(w, 500, "not_saved", "could not record that")
			return
		}
		if ct.RowsAffected() == 0 {
			bad(w, 404, "not_found", "no open session for that room")
			return
		}

		// Everybody still present leaves when the session ends.
		if in.State == "ended" {
			_, _ = st.pool.Exec(r.Context(), `
				UPDATE crm.room_participants p
				   SET left_at = now()
				  FROM crm.room_sessions s
				 WHERE p.session_id = s.id AND s.room = $1 AND p.left_at IS NULL`, in.Room)
		}

		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

/* POST /crm/rooms/leave — and, more usefully, HOW IT TRAVELLED.

   `connection` is the number this whole table exists to collect.
   'relayed' means the media went through TURN and cost bandwidth;
   'direct' means it did not. Counting them answers the sizing
   question the architecture doc could only estimate. */
func crmRoomLeave(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Room       string `json:"room"`
			Side       string `json:"side"`
			Connection string `json:"connection"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}

		switch in.Connection {
		case "direct", "relayed", "failed", "":
		default:
			in.Connection = ""
		}

		_, err := st.pool.Exec(r.Context(), `
			UPDATE crm.room_participants p
			   SET left_at    = COALESCE(p.left_at, now()),
			       connection = COALESCE(NULLIF($3,''), p.connection)
			  FROM crm.room_sessions s
			 WHERE p.session_id = s.id
			   AND s.room = $1 AND p.side = $2
			   AND p.id = (SELECT id FROM crm.room_participants
			                WHERE session_id = s.id AND side = $2
			                ORDER BY joined_at DESC LIMIT 1)`,
			in.Room, in.Side, in.Connection)
		if err != nil {
			bad(w, 500, "not_saved", "could not record that")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

// GET /crm/rooms?limit= — sessions, newest first, with both sides
func crmRoomList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := 50
		if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 200 {
			limit = n
		}

		rows, err := st.pool.Query(r.Context(), `
			SELECT s.id, s.room, s.state, s.started_at, s.ended_at,
			       COALESCE(s.started_by,''), s.source, s.created_at,
			       COALESCE(json_agg(
			         json_build_object(
			           'side', p.side,
			           'joinedAt', p.joined_at,
			           'leftAt', p.left_at,
			           'connection', p.connection
			         ) ORDER BY p.joined_at
			       ) FILTER (WHERE p.id IS NOT NULL), '[]')
			  FROM crm.room_sessions s
			  LEFT JOIN crm.room_participants p ON p.session_id = s.id
			 GROUP BY s.id
			 ORDER BY s.created_at DESC
			 LIMIT $1`, limit)
		if err != nil {
			bad(w, 500, "read_failed", "could not read the sessions")
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var id, room, state, startedBy, source string
			var startedAt, endedAt *time.Time
			var createdAt time.Time
			var sides []map[string]any
			if err := rows.Scan(&id, &room, &state, &startedAt, &endedAt,
				&startedBy, &source, &createdAt, &sides); err != nil {
				continue
			}
			out = append(out, map[string]any{
				"id": id, "room": room, "state": state, "source": source,
				"startedAt": ts(startedAt), "endedAt": ts(endedAt),
				"startedBy": startedBy, "createdAt": createdAt.Format(time.RFC3339),
				"sides": sides,
			})
		}
		writeJSON(w, 200, map[string]any{"ok": true, "sessions": out})
	}
}

/* POST /crm/ratings — what the client thought.

   Upserts, because the page asks once and a second arrival is
   somebody reloading rather than a second opinion. The last thing
   they said is what stands. */
func crmRatingAdd(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ConsultationID string `json:"consultationId"`
			Stars          *int   `json:"stars"`
			Comment        string `json:"comment"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.ConsultationID == "" {
			bad(w, 400, "invalid", "a consultation is needed")
			return
		}
		// Out of range is treated as unsaid rather than refused — a
		// rating is a courtesy, and arguing with somebody about it is
		// the wrong hill.
		if in.Stars != nil && (*in.Stars < 1 || *in.Stars > 5) {
			in.Stars = nil
		}
		if len(in.Comment) > 2000 {
			in.Comment = in.Comment[:2000]
		}

		_, err := st.pool.Exec(r.Context(), `
			INSERT INTO crm.ratings (consultation_id, stars, comment)
			VALUES ($1, $2, $3)
			ON CONFLICT (consultation_id) DO UPDATE
			   SET stars = EXCLUDED.stars,
			       comment = EXCLUDED.comment,
			       created_at = now()`,
			in.ConsultationID, in.Stars, in.Comment)
		if err != nil {
			bad(w, 500, "not_saved", "could not record that")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}
