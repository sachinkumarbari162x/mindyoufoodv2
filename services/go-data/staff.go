// Staff and audit — the door's storage, and the record of what was done
//
//	GET    /crm/staff?email=      the credential row, for Node to check
//	POST   /crm/staff             create the one account, once
//	PATCH  /crm/staff/{id}        password, TOTP secret, login bookkeeping
//	POST   /crm/audit             append one entry
//	GET    /crm/audit             read them back, newest first
//
// Go stores the password hash and never verifies one. The hash format
// is decided in Node and opaque here, so it can change without a
// migration — and there is exactly one place in the system that knows
// how to check a password rather than two that must agree.
package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

type staffRow struct {
	ID              string  `json:"id"`
	Email           string  `json:"email"`
	PasswordHash    string  `json:"passwordHash"`
	TotpSecret      *string `json:"totpSecret"`
	TotpConfirmedAt *string `json:"totpConfirmedAt"`
	FailedAttempts  int     `json:"failedAttempts"`
	LockedUntil     *string `json:"lockedUntil"`
	LastLoginAt     *string `json:"lastLoginAt"`
}

// GET /crm/staff?email=
func crmStaffGet(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		email := r.URL.Query().Get("email")

		var row staffRow
		var lockedUntil, lastLogin, totpAt *time.Time

		role := r.URL.Query().Get("role")
		if role == "" {
			role = "crm"
		}

		q := `SELECT id, email, password_hash, totp_secret, totp_confirmed_at,
		             failed_attempts, locked_until, last_login_at
		        FROM crm.staff WHERE role = $1`
		args := []any{role}
		if email != "" {
			q += ` AND lower(email) = lower($2)`
			args = append(args, email)
		}
		q += ` ORDER BY created_at LIMIT 1`

		err := st.pool.QueryRow(r.Context(), q, args...).Scan(
			&row.ID, &row.Email, &row.PasswordHash, &row.TotpSecret, &totpAt,
			&row.FailedAttempts, &lockedUntil, &lastLogin,
		)
		if err != nil {
			// Not an error worth a 500: "there is no account yet" is a
			// real answer, and the first-run flow depends on hearing it.
			writeJSON(w, 200, map[string]any{"ok": true, "staff": nil})
			return
		}
		row.TotpConfirmedAt = ts(totpAt)
		row.LockedUntil = ts(lockedUntil)
		row.LastLoginAt = ts(lastLogin)
		writeJSON(w, 200, map[string]any{"ok": true, "staff": row})
	}
}

// POST /crm/staff — the one account, created once
func crmStaffCreate(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Email string `json:"email"`
			Hash  string `json:"passwordHash"`
			Role  string `json:"role"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.Email == "" || in.Hash == "" {
			bad(w, 400, "invalid", "email and password are both needed")
			return
		}

		/* One account, and the check is a count rather than a unique
		   index on purpose: the answer to "somebody already set this
		   up" should be a sentence, not a constraint violation. The
		   index is still there underneath. */
		role := in.Role
		if role == "" {
			role = "crm"
		}

		var n int
		if err := st.pool.QueryRow(r.Context(),
			`SELECT count(*) FROM crm.staff WHERE role = $1`, role).Scan(&n); err == nil && n > 0 {
			bad(w, 409, "already_set_up", "an account already exists for that door")
			return
		}

		var id string
		err := st.pool.QueryRow(r.Context(), `
			INSERT INTO crm.staff (email, password_hash, role)
			VALUES ($1, $2, $3) RETURNING id`, in.Email, in.Hash, role).Scan(&id)
		if err != nil {
			bad(w, 500, "write_failed", "could not create the account")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true, "id": id})
	}
}

// PATCH /crm/staff/{id}
func crmStaffPatch(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			PasswordHash   *string `json:"passwordHash"`
			TotpSecret     *string `json:"totpSecret"`
			ConfirmTotp    *bool   `json:"confirmTotp"`
			FailedAttempts *int    `json:"failedAttempts"`
			LockedUntil    *string `json:"lockedUntil"`
			TouchLogin     *bool   `json:"touchLogin"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}

		_, err := st.pool.Exec(r.Context(), `
			UPDATE crm.staff SET
			  password_hash     = COALESCE($2, password_hash),
			  totp_secret       = COALESCE($3, totp_secret),
			  totp_confirmed_at = CASE WHEN $4::bool THEN now() ELSE totp_confirmed_at END,
			  failed_attempts   = COALESCE($5, failed_attempts),
			  locked_until      = CASE WHEN $6::text IS NULL THEN locked_until
			                           WHEN $6 = '' THEN NULL
			                           ELSE $6::timestamptz END,
			  last_login_at     = CASE WHEN $7::bool THEN now() ELSE last_login_at END
			WHERE id = $1`,
			r.PathValue("id"), in.PasswordHash, in.TotpSecret,
			in.ConfirmTotp != nil && *in.ConfirmTotp,
			in.FailedAttempts, in.LockedUntil,
			in.TouchLogin != nil && *in.TouchLogin,
		)
		if err != nil {
			bad(w, 500, "write_failed", "could not update the account")
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	}
}

// POST /crm/audit — one entry, and it is never revised
func crmAuditAdd(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Actor  string          `json:"actor"`
			Action string          `json:"action"`
			Target string          `json:"target"`
			Before json.RawMessage `json:"before"`
			After  json.RawMessage `json:"after"`
			IPHash string          `json:"ipHash"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&in); err != nil {
			bad(w, 400, "bad_json", "could not read that")
			return
		}
		if in.Action == "" {
			bad(w, 400, "invalid", "an audit entry needs an action")
			return
		}
		if in.Actor == "" {
			in.Actor = "unknown"
		}

		_, err := st.pool.Exec(r.Context(), `
			INSERT INTO crm.audit (actor, action, target, before, after, ip_hash)
			VALUES ($1, $2, NULLIF($3,''), $4, $5, NULLIF($6,''))`,
			in.Actor, in.Action, in.Target,
			nullableJSON(in.Before), nullableJSON(in.After), in.IPHash)
		if err != nil {
			bad(w, 500, "write_failed", "could not record that")
			return
		}
		writeJSON(w, 201, map[string]any{"ok": true})
	}
}

// GET /crm/audit?limit=&action=
func crmAuditList(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit := 100
		if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 500 {
			limit = n
		}
		action := r.URL.Query().Get("action")

		rows, err := st.pool.Query(r.Context(), `
			SELECT id, at, actor, action, COALESCE(target,''),
			       COALESCE(before::text,''), COALESCE(after::text,'')
			  FROM crm.audit
			 WHERE ($1 = '' OR action = $1)
			 ORDER BY at DESC, id DESC
			 LIMIT $2`, action, limit)
		if err != nil {
			bad(w, 500, "read_failed", "could not read the log")
			return
		}
		defer rows.Close()

		out := []map[string]any{}
		for rows.Next() {
			var id int64
			var at time.Time
			var actor, act, target, before, after string
			if err := rows.Scan(&id, &at, &actor, &act, &target, &before, &after); err != nil {
				continue
			}
			out = append(out, map[string]any{
				"id": id, "at": at.Format(time.RFC3339), "actor": actor,
				"action": act, "target": target,
				"before": rawOrNil(before), "after": rawOrNil(after),
			})
		}
		writeJSON(w, 200, map[string]any{"ok": true, "entries": out})
	}
}

func nullableJSON(b json.RawMessage) any {
	if len(b) == 0 || string(b) == "null" {
		return nil
	}
	return string(b)
}

func rawOrNil(s string) any {
	if s == "" {
		return nil
	}
	return json.RawMessage(s)
}
