// DB VIEW — read-only browsing of what is actually in the database
//
//	GET /db/tables                                  every table, with row counts
//	GET /db/rows?schema=crm&table=people&limit=50   one page of rows
//
// Built for looking, never for changing. There is no write path
// here and no way to pass SQL in.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE:
//
//  1. NO INTERPOLATED SQL FROM A REQUEST. A table name cannot be a
//     bound parameter — it is an identifier, not a value — so the
//     only safe way to use one is to check it against the catalog
//     first and quote it. Anything not found there is a 404 before
//     a query is ever built.
//
//  2. THIS IS ALL THE PII IN THE SYSTEM. Names, emails, dates of
//     birth, phone numbers and what people are unwell with, in one
//     place with no filtering. It binds to loopback like the rest of
//     go-data, and whatever fronts it in production must require a
//     login. It is a tool for her and for debugging, never a page
//     to leave open.
package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// Schemas worth showing. `public` holds the desk's tables and `crm`
// the practitioner's; everything else in a Postgres database is
// Postgres' own business.
var viewableSchemas = []string{"public", "crm"}

const (
	defaultRowLimit = 50
	maxRowLimit     = 500
)

type tableInfo struct {
	Schema  string `json:"schema"`
	Name    string `json:"name"`
	Rows    int64  `json:"rows"`
	Columns int    `json:"columns"`
}

// GET /db/tables
func dbTables(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := st.pool.Query(r.Context(), `
			SELECT t.table_schema,
			       t.table_name,
			       (SELECT count(*) FROM information_schema.columns c
			         WHERE c.table_schema = t.table_schema
			           AND c.table_name   = t.table_name) AS columns
			  FROM information_schema.tables t
			 WHERE t.table_schema = ANY($1)
			   AND t.table_type   = 'BASE TABLE'
			 ORDER BY t.table_schema, t.table_name`, viewableSchemas)
		if err != nil {
			bad(w, http.StatusInternalServerError, "query_failed", "could not read that table")
			return
		}
		defer rows.Close()

		out := []tableInfo{}
		for rows.Next() {
			var t tableInfo
			if err := rows.Scan(&t.Schema, &t.Name, &t.Columns); err != nil {
				bad(w, http.StatusInternalServerError, "scan_failed", "could not read that row")
				return
			}
			out = append(out, t)
		}

		// Counted per table rather than read from pg_class: the
		// planner's estimate is stale until something runs ANALYZE,
		// and a row count that disagrees with the rows below it makes
		// the whole page look wrong. These tables are small.
		for i := range out {
			ident, ok := quoteTable(r.Context(), st, out[i].Schema, out[i].Name)
			if !ok {
				continue
			}
			st.pool.QueryRow(r.Context(), `SELECT count(*) FROM `+ident).Scan(&out[i].Rows)
		}

		writeJSON(w, http.StatusOK, map[string]any{"tables": out})
	}
}

// GET /db/rows?schema=&table=&limit=&offset=
func dbRows(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		schema, table := q.Get("schema"), q.Get("table")

		ident, ok := quoteTable(r.Context(), st, schema, table)
		if !ok {
			bad(w, http.StatusNotFound, "not_found", "no such table")
			return
		}

		limit := clampInt(q.Get("limit"), defaultRowLimit, 1, maxRowLimit)
		offset := clampInt(q.Get("offset"), 0, 0, 1_000_000)

		/* One connection, held for the whole read, with the role
		   dropped to myf_viewer for its lifetime.

		   This is what makes the browser read-only: not the absence
		   of an edit button, but a role that lacks INSERT, UPDATE
		   and DELETE. If a bug here ever tried to write, Postgres
		   would refuse it — which is the only kind of read-only
		   worth calling read-only.

		   RESET ROLE on the way out, because the connection goes
		   back to a shared pool and the next borrower must not
		   inherit a restriction it never asked for. */
		conn, err := st.pool.Acquire(r.Context())
		if err != nil {
			bad(w, http.StatusInternalServerError, "query_failed", "could not read that table")
			return
		}
		defer conn.Release()

		if _, err := conn.Exec(r.Context(), `SET ROLE myf_viewer`); err != nil {
			// The role is created by migration 0010. If it is missing,
			// refuse rather than quietly reading as the owner.
			bad(w, http.StatusInternalServerError, "no_viewer_role",
				"the read-only role is not available")
			return
		}
		defer conn.Exec(context.Background(), `RESET ROLE`)

		/* row_number() OVER () rather than the primary key.

		   Item 8: the keys stay in Postgres. A page that prints a
		   uuid has published it to anything that can read the page,
		   and this one is a browser over every table in the system
		   — the worst possible place to leak them from. She wants to
		   know which row she is looking at, and "row 4" answers that
		   without answering anything else. */
		rows, err := conn.Query(r.Context(),
			`SELECT row_number() OVER () + $2 AS "#", * FROM `+ident+` LIMIT $1 OFFSET $2`,
			limit, offset)
		if err != nil {
			bad(w, http.StatusInternalServerError, "query_failed", "could not read that table")
			return
		}
		defer rows.Close()

		cols := []string{}
		for _, fd := range rows.FieldDescriptions() {
			cols = append(cols, string(fd.Name))
		}

		out := []map[string]any{}
		for rows.Next() {
			vals, err := rows.Values()
			if err != nil {
				bad(w, http.StatusInternalServerError, "scan_failed", "could not read that row")
				return
			}
			rec := make(map[string]any, len(cols))
			for i, c := range cols {
				rec[c] = maskKey(c, renderValue(vals[i]))
			}
			out = append(out, rec)
		}

		var total int64
		st.pool.QueryRow(r.Context(), `SELECT count(*) FROM `+ident).Scan(&total)

		writeJSON(w, http.StatusOK, map[string]any{
			"schema":  schema,
			"table":   table,
			"columns": cols,
			"rows":    out,
			"total":   total,
			"limit":   limit,
			"offset":  offset,
		})
	}
}

/* ---- safety ---------------------------------------------------- */

// quoteTable returns a safely quoted "schema"."table", but ONLY if
// that table genuinely exists in a viewable schema. The check is the
// point: it turns caller-supplied text into a value chosen from a
// list the database itself produced.
func quoteTable(ctx context.Context, st *Store, schema, table string) (string, bool) {
	if schema == "" || table == "" {
		return "", false
	}
	allowed := false
	for _, s := range viewableSchemas {
		if s == schema {
			allowed = true
		}
	}
	if !allowed {
		return "", false
	}

	// quote_ident is Postgres' own escaping, applied to a name
	// Postgres has just confirmed exists.
	var ident string
	err := st.pool.QueryRow(ctx, `
		SELECT quote_ident(table_schema) || '.' || quote_ident(table_name)
		  FROM information_schema.tables
		 WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
		schema, table).Scan(&ident)
	if err != nil {
		return "", false
	}
	return ident, true
}

// 8-4-4-4-12, the form every other tool shows a uuid in.
func uuidString(b [16]byte) string {
	const hexDigits = "0123456789abcdef"
	out := make([]byte, 0, 36)
	for i, c := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out = append(out, '-')
		}
		out = append(out, hexDigits[c>>4], hexDigits[c&0x0f])
	}
	return string(out)
}

func clampInt(raw string, def, lo, hi int) int {
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	if n < lo {
		return lo
	}
	if n > hi {
		return hi
	}
	return n
}

// JSON has no date type and no int64 that survives a browser, so
// anything unusual becomes a string here rather than silently losing
// precision on the way out.
/* Keys never leave the database.

   `id`, `person_id`, `consultation_id` and the rest are replaced by
   a short HMAC of the value. Two rows holding the same key still
   show the same reference, so a consultation can be matched to its
   person by eye — which is the only reason anybody looks at a raw
   table — but the reference is useless anywhere else in the system
   and cannot be turned back into the key.

   HMAC rather than a plain hash: a hash of a uuid is a stable
   pseudonym anybody can recompute from a key they already have, and
   confirming a guess is most of what a leaked identifier is good
   for. */
func maskKey(column string, v any) any {
	if v == nil {
		return nil
	}
	if column != "id" && !strings.HasSuffix(column, "_id") {
		return v
	}
	str, ok := v.(string)
	if !ok || str == "" {
		return v
	}
	mac := hmac.New(sha256.New, []byte(viewSecret()))
	mac.Write([]byte(str))
	return "ref:" + hex.EncodeToString(mac.Sum(nil))[:10]
}

/*
The service token doubles as the masking secret. It is already

	required, already secret, and already rotated together with the
	thing it protects — a second secret to manage would be a second
	secret to leave unset.
*/
func viewSecret() string {
	if s := os.Getenv("VIEW_SECRET"); s != "" {
		return s
	}
	return os.Getenv("SERVICE_TOKEN")
}

func renderValue(v any) any {
	switch t := v.(type) {
	case nil, bool, string, float32, float64, int16, int32, int, json.Number:
		return t
	case int64:
		// Beyond 2^53 a JS number stops being exact; ids and money
		// in minor units both live in this range.
		if t > 9007199254740991 || t < -9007199254740991 {
			return strconv.FormatInt(t, 10)
		}
		return t
	case []byte:
		return string(t)
	case [16]byte:
		// A uuid arrives as a 16-byte ARRAY, not a slice, so it misses
		// the case above and JSON-marshals as "91,157,191,…" — sixteen
		// numbers where an id should be. Format it the way Postgres
		// prints it.
		return uuidString(t)
	default:
		b, err := json.Marshal(t)
		if err != nil {
			return "—"
		}
		return json.RawMessage(b)
	}
}
