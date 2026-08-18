// Progress — what a client can see of their own course, over time
//
//	GET /programme/{token}/weights   every weight they entered — PUBLIC
//
// READ-ONLY, and it hands back only what the client themselves put
// in. Weighing yourself is the one number in this app the client
// authors, and until now the app could only WRITE it: they typed a
// weight every week into a box that never showed them one back.
//
// WHAT IT DELIBERATELY DOES NOT RETURN. crm.measurements also holds
// what SHE recorded at the consultation — height, waist, body fat,
// anything she took herself, and clinical measurements taken by a
// practitioner are hers to interpret in a session, not a number to
// find alone on a phone at midnight. So this is filtered twice: to
// weight_kg, and to source = 'self'. A client sees their own
// handwriting and nothing else.
//
// SCOPED TO THE PROGRAMME, not to the person. Somebody on their
// second course sees the second course. The first one belonged to a
// plan that has finished and a link that may well have been revoked.
package main

import (
	"net/http"

	"github.com/jackc/pgx/v5"
)

/* Two a week for a year would be a hundred. This is a phone drawing
   a line: past a few hundred points the line is the same picture and
   the payload is not. */
const weightsMax = 400

// GET /programme/{token}/weights — PUBLIC
func programmeWeights(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		progID, personID, _, ok := st.programmeFor(r, r.PathValue("token"))
		if !ok {
			bad(w, 404, "not_found", "that link is not valid")
			return
		}

		type weighIn struct {
			Date string  `json:"date"`
			Kg   float64 `json:"kg"`
		}

		/* Built as a non-nil slice so an empty history serialises as
		   [] and not null — the app draws "no weights yet" off the
		   length, and null would make it draw an error instead. */
		out := []weighIn{}

		/* ON THE CLIENT'S OWN CONNECTION. The WHERE clause below still
		   says person_id, and should: a boundary you can see in the
		   query is one the next reader understands. What asClient adds
		   is that the row filter no longer DEPENDS on that line being
		   there and being right. */
		err := st.asClient(r.Context(), personID, func(tx pgx.Tx) error {
			/* OLDEST FIRST, because it is a line and a line is read
			   left to right. Sorting it in the browser would be a
			   second place for the order to be decided. */
			rows, err := tx.Query(r.Context(), `
				SELECT to_char(taken_at, 'YYYY-MM-DD'), value
				  FROM crm.measurements
				 WHERE person_id    = $1
				   AND programme_id  = $2
				   AND metric        = 'weight'
				   AND source        = 'self'
				 ORDER BY taken_at
				 LIMIT $3`, personID, progID, weightsMax)
			if err != nil {
				return err
			}
			defer rows.Close()

			for rows.Next() {
				var one weighIn
				if err := rows.Scan(&one.Date, &one.Kg); err != nil {
					continue
				}
				out = append(out, one)
			}
			return rows.Err()
		})
		if err != nil {
			bad(w, 500, "read_failed", "could not read that")
			return
		}

		writeJSON(w, 200, map[string]any{"ok": true, "weights": out})
	}
}
