/* ============================================================
   METRICS — the registry, the units, and what she has chosen
   ------------------------------------------------------------
   Three reads and one write.

     GET   /crm/metrics          the catalogue
     GET   /crm/units            every unit, and the standards
     GET   /crm/settings         what this practice has chosen
     PATCH /crm/settings/{key}   change one of them

   WHY THE REGISTRY IS SERVED RATHER THAN COMPILED IN. Every
   screen that shows a number needs the same four facts about it:
   what to call it, how many decimals, which way is better, and
   what counts as normal. Those facts have to be identical in the
   CRM, in the client's panel and in a printed plan, and the only
   way three surfaces agree for ever is if there is one copy and
   they all read it.

   NOTHING HERE CONVERTS ANYTHING. Values are stored canonical
   and converted at the edge, by the one small module that does
   the arithmetic. This hands over the factors; it does not apply
   them. That is deliberate: a conversion done server-side would
   have to know which client is looking at it, and this service
   already refuses to make display decisions.

   THE SETTINGS ARE HERS AND THEY ARE AUDITED. Changing a unit
   standard changes every number on every screen — not what is
   stored, but what everybody reads — and a change of that reach
   should leave a record of who made it.
   ============================================================ */
package main

import (
	"encoding/json"
	"net/http"
	"time"
)

/* ---- the catalogue ---------------------------------------------- */

type metricDef struct {
	Key         string          `json:"key"`
	Tier        string          `json:"tier"`
	Family      string          `json:"family"`
	Label       string          `json:"label"`
	ShortLabel  string          `json:"shortLabel"`
	Description string          `json:"description"`
	Dimension   *string         `json:"dimension"`
	Decimals    int             `json:"decimals"`
	Formula     string          `json:"formula"`
	DependsOn   []string        `json:"dependsOn"`
	Direction   string          `json:"direction"`
	RefLow      *float64        `json:"refLow"`
	RefHigh     *float64        `json:"refHigh"`
	Bands       json.RawMessage `json:"bands"`
	Source      string          `json:"source"`
	Cadence     string          `json:"cadence"`
	Sex         string          `json:"sex"`
	Sort        int             `json:"sort"`
}

/* GET /crm/metrics?tier=&family=

   The whole catalogue is under 200 rows and a couple of hundred
   kilobytes, so it is served in one piece and cached by the
   caller rather than paged. A screen that has to ask about one
   metric at a time is a screen that makes a hundred requests to
   draw a table. */
func crmMetrics(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := `
			SELECT key, tier, family, label, short_label, description,
			       dimension, decimals, formula, depends_on, direction,
			       ref_low, ref_high, bands, source, cadence, sex, sort
			  FROM crm.metric_defs
			 WHERE active`
		args := []any{}

		if tier := r.URL.Query().Get("tier"); tier != "" {
			args = append(args, tier)
			q += ` AND tier = $1`
		}
		if family := r.URL.Query().Get("family"); family != "" {
			args = append(args, family)
			if len(args) == 1 {
				q += ` AND family = $1`
			} else {
				q += ` AND family = $2`
			}
		}
		q += ` ORDER BY sort, key`

		rows, err := st.pool.Query(r.Context(), q, args...)
		if err != nil {
			bad(w, 500, "read_failed", "could not read the metrics")
			return
		}
		defer rows.Close()

		out := []metricDef{}
		for rows.Next() {
			var m metricDef
			if err := rows.Scan(&m.Key, &m.Tier, &m.Family, &m.Label, &m.ShortLabel,
				&m.Description, &m.Dimension, &m.Decimals, &m.Formula, &m.DependsOn,
				&m.Direction, &m.RefLow, &m.RefHigh, &m.Bands, &m.Source, &m.Cadence,
				&m.Sex, &m.Sort); err != nil {
				continue
			}
			out = append(out, m)
		}

		/* Counted by tier as well as listed, because the first
		   question anybody asks of a registry this size is how much
		   of it there is. */
		counts := map[string]int{}
		for _, m := range out {
			counts[m.Tier]++
		}

		writeJSON(w, 200, map[string]any{"ok": true, "metrics": out, "counts": counts})
	}
}

/* ---- units ------------------------------------------------------ */

// GET /crm/units — everything needed to convert and to format.
func crmUnits(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		type unit struct {
			Code      string  `json:"code"`
			Dimension string  `json:"dimension"`
			Label     string  `json:"label"`
			Symbol    string  `json:"symbol"`
			Factor    float64 `json:"factor"`
			Offset    float64 `json:"offset"`
			Canonical bool    `json:"canonical"`
			Decimals  int     `json:"decimals"`
		}

		rows, err := st.pool.Query(ctx, `
			SELECT code, dimension, label, symbol, factor, "offset", canonical, decimals
			  FROM crm.units ORDER BY dimension, sort`)
		if err != nil {
			bad(w, 500, "read_failed", "could not read the units")
			return
		}
		units := []unit{}
		for rows.Next() {
			var u unit
			if err := rows.Scan(&u.Code, &u.Dimension, &u.Label, &u.Symbol,
				&u.Factor, &u.Offset, &u.Canonical, &u.Decimals); err != nil {
				continue
			}
			units = append(units, u)
		}
		rows.Close()

		type standard struct {
			Code        string            `json:"code"`
			Label       string            `json:"label"`
			Description string            `json:"description"`
			Units       map[string]string `json:"units"`
		}

		srows, err := st.pool.Query(ctx,
			`SELECT code, label, description FROM crm.unit_standards ORDER BY sort`)
		if err != nil {
			bad(w, 500, "read_failed", "could not read the standards")
			return
		}
		standards := []standard{}
		index := map[string]int{}
		for srows.Next() {
			var s standard
			if err := srows.Scan(&s.Code, &s.Label, &s.Description); err != nil {
				continue
			}
			s.Units = map[string]string{}
			index[s.Code] = len(standards)
			standards = append(standards, s)
		}
		srows.Close()

		urows, err := st.pool.Query(ctx,
			`SELECT standard, dimension, unit FROM crm.unit_standard_units`)
		if err != nil {
			bad(w, 500, "read_failed", "could not read the standards")
			return
		}
		for urows.Next() {
			var std, dim, u string
			if err := urows.Scan(&std, &dim, &u); err != nil {
				continue
			}
			if i, ok := index[std]; ok {
				standards[i].Units[dim] = u
			}
		}
		urows.Close()

		writeJSON(w, 200, map[string]any{
			"ok": true, "units": units, "standards": standards,
		})
	}
}

/* ---- settings --------------------------------------------------- */

type setting struct {
	Key         string          `json:"key"`
	Value       json.RawMessage `json:"value"`
	Label       string          `json:"label"`
	Description string          `json:"description"`
	UpdatedAt   *string         `json:"updatedAt"`
	UpdatedBy   string          `json:"updatedBy"`
}

// GET /crm/settings
func crmSettings(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := st.pool.Query(r.Context(), `
			SELECT key, value, label, description, updated_at, updated_by
			  FROM crm.settings ORDER BY key`)
		if err != nil {
			bad(w, 500, "read_failed", "could not read the settings")
			return
		}
		defer rows.Close()

		out := []setting{}
		for rows.Next() {
			var s setting
			var at time.Time
			if err := rows.Scan(&s.Key, &s.Value, &s.Label, &s.Description, &at, &s.UpdatedBy); err != nil {
				continue
			}
			s.UpdatedAt = ts(&at)
			out = append(out, s)
		}
		writeJSON(w, 200, map[string]any{"ok": true, "settings": out})
	}
}

/* PATCH /crm/settings/{key}  {value, by}

   REFUSES A KEY THAT DOES NOT EXIST rather than creating one. A
   settings table anybody can add rows to is a settings table
   where a typo becomes a silent no-op — the code reads
   `units.standard`, somebody writes `unit.standard`, and nothing
   happens and nothing complains. Every key this system honours
   is created by db/config_units.sql, which is also where its
   label and its explanation live. */
func crmSettingSave(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := r.PathValue("key")

		var in struct {
			Value json.RawMessage `json:"value"`
			By    string          `json:"by"`
		}
		if err := decode(r, &in); err != nil || len(in.Value) == 0 {
			bad(w, 400, "bad_json", "could not read that")
			return
		}

		ctx := r.Context()

		/* WHAT IT WAS, for the audit line. Read before the write and
		   inside the same request, because "she changed the unit
		   standard" is a fraction as useful as "she changed it from
		   metric to US customary". */
		var before json.RawMessage
		_ = st.pool.QueryRow(ctx,
			`SELECT value FROM crm.settings WHERE key = $1`, key).Scan(&before)

		var after json.RawMessage
		err := st.pool.QueryRow(ctx, `
			UPDATE crm.settings
			   SET value = $2, updated_at = now(), updated_by = $3
			 WHERE key = $1
			RETURNING value`, key, in.Value, in.By).Scan(&after)
		if err != nil {
			bad(w, 404, "no_such_setting", "there is no setting by that name")
			return
		}

		/* Audited, because changing one of these changes what every
		   number on every screen says. Best-effort: the setting is
		   already saved and failing the request over the record of it
		   would be the wrong way round. */
		_, _ = st.pool.Exec(ctx, `
			INSERT INTO crm.audit (actor, action, target, before, after)
			VALUES ($1, 'setting.changed', $2, $3, $4)`,
			in.By, key, before, after)

		writeJSON(w, 200, map[string]any{"ok": true, "key": key, "value": after})
	}
}
