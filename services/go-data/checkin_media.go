// Photographs attached to a check-in
//
//	POST /programme/{token}/media   record one — PUBLIC
//	GET  /programme/{token}/media   theirs, to draw the app — PUBLIC
//	GET  /crm/media?programmeId=    hers, to look at
//	GET  /crm/media/one?id=         one row, to serve the bytes
//
// GO NEVER SEES THE BYTES. The BFF stores the file and calls this
// with a key, a hash and a size; this records that a photograph
// exists and where it went. Two consequences worth stating: the
// database stays small enough to back up, and the storage decision
// stays a BFF concern that can change without a migration.
//
// THE CHECK-IN MUST BE THEIRS. A token holder posting a media row
// against somebody else's check-in id would attach their photograph
// to a stranger's record, so the insert is constrained by the
// programme rather than trusted from the body.
package main

import (
	"encoding/json"
	"net/http"
	"time"
)

type media struct {
	ID         string  `json:"id"`
	CheckinID  string  `json:"checkinId"`
	StorageKey string  `json:"storageKey"`
	Mime       string  `json:"mime"`
	Bytes      int     `json:"bytes"`
	Sha256     string  `json:"sha256"`
	Width      *int    `json:"width"`
	Height     *int    `json:"height"`
	TakenAt    string  `json:"takenAt"`
	OnDate     *string `json:"onDate"`
	ItemLabel  *string `json:"itemLabel"`
}

/* POST /programme/{token}/media — PUBLIC.

   Called by the BFF once the bytes are safely stored. Everything
   about WHERE they went is opaque here. */
func programmeMediaAdd(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		progID, _, _, ok := st.programmeFor(r, r.PathValue("token"))
		if !ok {
			bad(w, 404, "not_found", "that link is not valid")
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
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
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
				/* Trusted only within reason. A phone with a wrong clock
				   should not be able to file a photograph in the middle
				   of last year, so anything outside a fortnight either
				   side falls back to now. */
				if t.After(time.Now().AddDate(0, 0, -14)) && t.Before(time.Now().AddDate(0, 0, 1)) {
					taken = t
				}
			}
		}

		/* THE SELECT IS THE PERMISSION CHECK. Insert only if that
		   check-in belongs to this programme — a guessed id from
		   somebody else's record inserts nothing rather than
		   attaching a photograph to a stranger. */
		var id string
		err := st.pool.QueryRow(r.Context(), `
			INSERT INTO crm.checkin_media
			  (checkin_id, storage_key, mime, bytes, sha256, width, height, taken_at)
			SELECT c.id, $3, $4, $5, $6, $7, $8, $9
			  FROM crm.checkins c
			 WHERE c.id = $1 AND c.programme_id = $2
			ON CONFLICT (checkin_id, sha256) DO UPDATE SET storage_key = EXCLUDED.storage_key
			RETURNING id`,
			in.CheckinID, progID, in.StorageKey, in.Mime, in.Bytes, in.Sha256,
			in.Width, in.Height, taken).Scan(&id)
		if err != nil {
			bad(w, 404, "not_found", "that is not on your programme")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true, "id": id})
	}
}

const mediaCols = `
	m.id, m.checkin_id, m.storage_key, m.mime, m.bytes, m.sha256,
	m.width, m.height, m.taken_at,
	to_char(c.on_date, 'YYYY-MM-DD'), i.label`

func scanMedia(rows interface {
	Next() bool
	Scan(...any) error
	Close()
}) []media {
	defer rows.Close()
	out := []media{}
	for rows.Next() {
		var m media
		var taken time.Time
		if err := rows.Scan(&m.ID, &m.CheckinID, &m.StorageKey, &m.Mime, &m.Bytes,
			&m.Sha256, &m.Width, &m.Height, &taken, &m.OnDate, &m.ItemLabel); err != nil {
			continue
		}
		m.TakenAt = taken.Format(time.RFC3339)
		out = append(out, m)
	}
	return out
}

// GET /programme/{token}/media — PUBLIC. What they have sent.
func programmeMediaList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		progID, _, _, ok := st.programmeFor(r, r.PathValue("token"))
		if !ok {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}
		rows, err := st.pool.Query(r.Context(), `
			SELECT `+mediaCols+`
			  FROM crm.checkin_media m
			  JOIN crm.checkins c ON c.id = m.checkin_id
			  JOIN crm.plan_items i ON i.id = c.plan_item_id
			 WHERE c.programme_id = $1 AND c.on_date > current_date - 35
			 ORDER BY m.taken_at DESC
			 LIMIT 200`, progID)
		if err != nil {
			bad(w, 500, "read_failed", "could not read those")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "media": scanMedia(rows)})
	}
}

// GET /crm/media?programmeId= — hers.
func crmMediaList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("programmeId")
		if id == "" {
			bad(w, 400, "invalid", "a programme is needed")
			return
		}
		rows, err := st.pool.Query(r.Context(), `
			SELECT `+mediaCols+`
			  FROM crm.checkin_media m
			  JOIN crm.checkins c ON c.id = m.checkin_id
			  JOIN crm.plan_items i ON i.id = c.plan_item_id
			 WHERE c.programme_id = $1
			 ORDER BY m.taken_at DESC
			 LIMIT 300`, id)
		if err != nil {
			bad(w, 500, "read_failed", "could not read those")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "media": scanMedia(rows)})
	}
}

/* GET /crm/media/one?id= — one row, so the BFF can fetch its bytes.

   Separate from the list because serving an image is a different
   act from drawing a grid, and the route that reads a file off a
   disk should take exactly one id and nothing else. */
func crmMediaOne(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var key, mime string
		if err := st.pool.QueryRow(r.Context(),
			`SELECT storage_key, mime FROM crm.checkin_media WHERE id = $1`,
			r.URL.Query().Get("id")).Scan(&key, &mime); err != nil {
			bad(w, 404, "not_found", "no photo with that reference")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "storageKey": key, "mime": mime})
	}
}

/* GET /programme/{token}/media/one?id= — PUBLIC, and scoped.

   The client's own copy of the route above. The programme is joined
   in rather than trusted, so a token holder can only ever resolve a
   key belonging to their own photographs. */
func programmeMediaOne(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		progID, _, _, ok := st.programmeFor(r, r.PathValue("token"))
		if !ok {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}
		var key, mime string
		if err := st.pool.QueryRow(r.Context(), `
			SELECT m.storage_key, m.mime
			  FROM crm.checkin_media m
			  JOIN crm.checkins c ON c.id = m.checkin_id
			 WHERE m.id = $1 AND c.programme_id = $2`,
			r.URL.Query().Get("id"), progID).Scan(&key, &mime); err != nil {
			bad(w, 404, "not_found", "no photo with that reference")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "storageKey": key, "mime": mime})
	}
}
