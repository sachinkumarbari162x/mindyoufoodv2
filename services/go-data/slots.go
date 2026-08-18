// THE SLOT ENGINE — which times may actually be offered
//
//	GET /crm/slots?from=2026-08-13&days=14
//
// A booking without a time is not a booking. Until now the desk
// suggested a mid-morning hour from a hard-coded pattern and nothing
// checked whether she was free; this decides it properly:
//
//	  her published week          availability_rules
//	− days she has closed         availability_exceptions (closed)
//	+ one-off openings            availability_exceptions (open)
//	− slots already taken         crm.consultations (held | confirmed)
//	− anything inside the notice period
//	− whole days already at their cap
//	= what a visitor may be shown
//
// IT LIVES IN GO, NOT IN NODE, on purpose. The "already taken" half
// can only be answered by the database, and an answer computed
// anywhere else is a snapshot that was true a moment ago. The desk
// asks; it never works it out.
//
// This produces CANDIDATES, not reservations. Two visitors can be
// shown the same slot a second apart — the partial unique index on
// crm.consultations is what refuses the second write. Availability is
// advice; the index is the truth.
package main

import (
	"context"
	"net/http"
	"time"

	// Embedded so Asia/Kolkata resolves the same on a laptop, in a
	// scratch container, and on the box — without depending on the OS
	// having a timezone database installed.
	_ "time/tzdata"
)

type slot struct {
	StartAt string `json:"startAt"`
	EndAt   string `json:"endAt"`
	Date    string `json:"date"`  // 2026-08-20, practice-local
	Time    string `json:"time"`  // 16:00, practice-local
	Label   string `json:"label"` // Thursday 20 Aug · 16:00
}

type band struct{ startMin, endMin int }

// freeSlots walks each day in the window and returns what may be
// offered, soonest first.
func (s *Store) freeSlots(ctx context.Context, from time.Time, days int) ([]slot, error) {
	cfg := s.cfg
	loc, err := time.LoadLocation(cfg.Timezone)
	if err != nil {
		loc = time.UTC
	}

	rules, err := s.weeklyRules(ctx)
	if err != nil {
		return nil, err
	}
	closed, opened, err := s.exceptions(ctx)
	if err != nil {
		return nil, err
	}
	taken, err := s.takenSlots(ctx)
	if err != nil {
		return nil, err
	}

	now := time.Now().In(loc)
	// Nothing inside the notice period may be offered — confirming a
	// slot two hours away costs a real exchange of emails to undo.
	earliest := now.Add(time.Duration(cfg.MinLeadHours) * time.Hour)

	step := time.Duration(cfg.ConsultMinutes+cfg.BufferMinutes) * time.Minute
	length := time.Duration(cfg.ConsultMinutes) * time.Minute

	out := []slot{}
	day := time.Date(from.Year(), from.Month(), from.Day(), 0, 0, 0, 0, loc)

	for d := 0; d < days; d++ {
		date := day.Format("2006-01-02")

		// A closure shuts the whole day and outranks everything else:
		// it is the row she added because something came up, and a
		// pattern set weeks earlier must not override it.
		if closed[date] {
			day = day.AddDate(0, 0, 1)
			continue
		}

		bands := append([]band{}, rules[int(day.Weekday())]...)
		bands = append(bands, opened[date]...)

		perDay := 0
		// Nothing stops her setting 10:00-13:00 and 12:00-15:00 on the
		// same day — they are two legitimate bands that happen to
		// overlap. Without this, noon would be offered twice and she
		// would see the same hour listed as two free slots.
		seen := map[int]bool{}

		for _, b := range bands {
			for m := b.startMin; m+cfg.ConsultMinutes <= b.endMin; m += int(step.Minutes()) {
				if perDay >= cfg.MaxPerDay {
					break
				}
				if seen[m] {
					continue
				}
				seen[m] = true

				start := day.Add(time.Duration(m) * time.Minute)
				if start.Before(earliest) {
					continue
				}
				if taken[start.UTC().Truncate(time.Minute)] {
					continue
				}

				end := start.Add(length)
				out = append(out, slot{
					StartAt: start.UTC().Format(time.RFC3339),
					EndAt:   end.UTC().Format(time.RFC3339),
					Date:    start.Format("2006-01-02"),
					Time:    start.Format("15:04"),
					Label:   start.Format("Monday 2 Jan") + " · " + start.Format("15:04"),
				})
				perDay++
			}
		}

		day = day.AddDate(0, 0, 1)
	}

	return out, nil
}

/* ---- the pieces -------------------------------------------------- */

// Her published week, as bands per weekday. Only rules in force today
// count: an old season's pattern has an effective_to in the past.
func (s *Store) weeklyRules(ctx context.Context) (map[int][]band, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT weekday, starts_min, ends_min
		  FROM availability_rules
		 WHERE effective_from <= current_date
		   AND (effective_to IS NULL OR effective_to >= current_date)
		 ORDER BY weekday, starts_min`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[int][]band{}
	for rows.Next() {
		var dow, a, b int
		if err := rows.Scan(&dow, &a, &b); err != nil {
			return nil, err
		}
		out[dow] = append(out[dow], band{a, b})
	}
	return out, rows.Err()
}

func (s *Store) exceptions(ctx context.Context) (map[string]bool, map[string][]band, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT on_date, kind, starts_min, ends_min
		  FROM availability_exceptions
		 WHERE on_date >= current_date`)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	closed := map[string]bool{}
	opened := map[string][]band{}
	for rows.Next() {
		var on time.Time
		var kind string
		var a, b *int
		if err := rows.Scan(&on, &kind, &a, &b); err != nil {
			return nil, nil, err
		}
		date := on.Format("2006-01-02")
		if kind == "closed" {
			closed[date] = true
		} else if a != nil && b != nil {
			opened[date] = append(opened[date], band{*a, *b})
		}
	}
	return closed, opened, rows.Err()
}

// Everything held or confirmed. `held` counts: a slot somebody is
// deciding on is not free, or two visitors are sent to the same hour
// and one of them is disappointed after being told it was theirs.
func (s *Store) takenSlots(ctx context.Context) (map[time.Time]bool, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT scheduled_start_at
		  FROM crm.consultations
		 WHERE status IN ('held', 'confirmed')
		   AND scheduled_start_at IS NOT NULL
		   AND scheduled_start_at > now() - interval '1 day'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[time.Time]bool{}
	for rows.Next() {
		var t time.Time
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out[t.UTC().Truncate(time.Minute)] = true
	}
	return out, rows.Err()
}

/* ---- handler ------------------------------------------------------ */

func crmSlots(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()

		loc, err := time.LoadLocation(st.cfg.Timezone)
		if err != nil {
			loc = time.UTC
		}
		from := time.Now().In(loc)
		if raw := q.Get("from"); raw != "" {
			if parsed, err := time.ParseInLocation("2006-01-02", raw, loc); err == nil {
				from = parsed
			}
		}

		days := clampInt(q.Get("days"), 14, 1, st.cfg.MaxHorizonDays)

		list, err := st.freeSlots(r.Context(), from, days)
		if err != nil {
			bad(w, 500, "query_failed", "could not work out availability")
			return
		}

		limit := clampInt(q.Get("limit"), 60, 1, 200)
		if len(list) > limit {
			list = list[:limit]
		}

		writeJSON(w, 200, map[string]any{
			"slots":    list,
			"timezone": st.cfg.Timezone,
			"minutes":  st.cfg.ConsultMinutes,
		})
	}
}
