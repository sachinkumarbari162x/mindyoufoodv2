// The month, as she actually works it
//
//	GET /crm/calendar?from=2026-08-01&to=2026-08-31
//
// One entry per day, carrying the three things that decide what a
// day IS: her published week, whatever overrides it, and who is
// booked into it.
//
// WHY THIS IS NOT THE SLOT ENGINE. slots.go answers "what may I
// offer a visitor", which is a forward-looking question — its
// helpers are anchored to current_date and deliberately know
// nothing about last month. A calendar has to answer "what did
// that Tuesday look like" as readily as "what does next Tuesday
// look like", so it reads the same two tables over an arbitrary
// range instead.
//
// The two must not drift, which is why this returns BANDS rather
// than slots: the moment this file started dividing bands into
// appointments it would be a second implementation of the engine,
// and the two would disagree about a Tuesday within the year.
package main

import (
	"net/http"
	"time"
)

type calendarDay struct {
	Date     string        `json:"date"`
	Weekday  int           `json:"weekday"`
	Bands    []calBand     `json:"bands"`
	Closed   bool          `json:"closed"`
	Reason   string        `json:"reason"`
	Bookings []calBooking  `json:"bookings"`
}

type calBand struct {
	StartMin int    `json:"startMin"`
	EndMin   int    `json:"endMin"`
	Source   string `json:"source"` // "weekly" or "one-off"
}

type calBooking struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	StartAt string `json:"startAt"`
	Status  string `json:"status"`
	Mode    string `json:"mode"`
}

// GET /crm/calendar?from=&to=
func crmCalendar(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		from, err1 := time.Parse("2006-01-02", q.Get("from"))
		to, err2 := time.Parse("2006-01-02", q.Get("to"))
		if err1 != nil || err2 != nil || to.Before(from) {
			bad(w, 400, "invalid", "a from and to date are needed")
			return
		}
		/* Bounded. A calendar is asked for a month at a time; a
		   request for five years would build a slice nobody reads and
		   a query nobody expected. */
		if to.Sub(from) > 400*24*time.Hour {
			bad(w, 400, "too_wide", "that range is longer than a year")
			return
		}

		ctx := r.Context()
		loc, err := time.LoadLocation(st.cfg.Timezone)
		if err != nil {
			loc = time.UTC
		}

		/* ---- her published week, as it applied ACROSS THE RANGE.
		   A rule that ended in June still explains June, so the
		   effective dates are compared to the range rather than to
		   today — which is the whole difference between a calendar
		   and the slot engine. */
		weekly := map[int][]calBand{}
		rows, err := st.pool.Query(ctx, `
			SELECT weekday, starts_min, ends_min
			  FROM availability_rules
			 WHERE effective_from <= $2
			   AND (effective_to IS NULL OR effective_to >= $1)
			 ORDER BY weekday, starts_min`,
			from.Format("2006-01-02"), to.Format("2006-01-02"))
		if err != nil {
			bad(w, 500, "read_failed", "could not read her week")
			return
		}
		for rows.Next() {
			var dow, a, b int
			if err := rows.Scan(&dow, &a, &b); err != nil {
				continue
			}
			weekly[dow] = append(weekly[dow], calBand{StartMin: a, EndMin: b, Source: "weekly"})
		}
		rows.Close()

		// ---- the days that break it
		closed := map[string]string{}       // date -> reason
		opened := map[string][]calBand{}    // date -> extra bands
		erows, err := st.pool.Query(ctx, `
			SELECT on_date, kind, starts_min, ends_min, COALESCE(reason,'')
			  FROM availability_exceptions
			 WHERE on_date BETWEEN $1 AND $2`,
			from.Format("2006-01-02"), to.Format("2006-01-02"))
		if err != nil {
			bad(w, 500, "read_failed", "could not read the exceptions")
			return
		}
		for erows.Next() {
			var on time.Time
			var kind, reason string
			var a, b *int
			if err := erows.Scan(&on, &kind, &a, &b, &reason); err != nil {
				continue
			}
			date := on.Format("2006-01-02")
			if kind == "closed" {
				// An empty reason still means closed, so the map holds a
				// space rather than "" — presence is the signal.
				if reason == "" {
					reason = " "
				}
				closed[date] = reason
			} else if a != nil && b != nil {
				opened[date] = append(opened[date], calBand{StartMin: *a, EndMin: *b, Source: "one-off"})
			}
		}
		erows.Close()

		/* ---- and who is actually in the diary.
		   Declined bookings are left out: they are a record of
		   something that did not happen, and a calendar showing them
		   would be showing a day busier than it was. */
		booked := map[string][]calBooking{}
		brows, err := st.pool.Query(ctx, `
			SELECT c.id, p.name, c.scheduled_start_at, c.status, c.mode
			  FROM crm.consultations c
			  JOIN crm.people p ON p.id = c.person_id
			 WHERE c.scheduled_start_at IS NOT NULL
			   AND c.status <> 'declined'
			   AND c.scheduled_start_at >= $1::date
			   AND c.scheduled_start_at < ($2::date + 1)
			 ORDER BY c.scheduled_start_at`,
			from.Format("2006-01-02"), to.Format("2006-01-02"))
		if err != nil {
			bad(w, 500, "read_failed", "could not read the bookings")
			return
		}
		for brows.Next() {
			var b calBooking
			var at time.Time
			if err := brows.Scan(&b.ID, &b.Name, &at, &b.Status, &b.Mode); err != nil {
				continue
			}
			// Grouped by the date SHE sees, not by UTC — an 11pm IST
			// appointment is not tomorrow.
			local := at.In(loc)
			b.StartAt = at.UTC().Format(time.RFC3339)
			date := local.Format("2006-01-02")
			booked[date] = append(booked[date], b)
		}
		brows.Close()

		// ---- one entry per day, in order
		days := []calendarDay{}
		for d := from; !d.After(to); d = d.AddDate(0, 0, 1) {
			date := d.Format("2006-01-02")
			day := calendarDay{
				Date:     date,
				Weekday:  int(d.Weekday()),
				Bands:    []calBand{},
				Bookings: []calBooking{},
			}

			if reason, shut := closed[date]; shut {
				day.Closed = true
				if reason != " " {
					day.Reason = reason
				}
			} else {
				day.Bands = append(day.Bands, weekly[int(d.Weekday())]...)
			}

			/* A one-off opening survives a closure, and that is the
			   right way round: "closed on Tuesday, except 4 to 6 for
			   one person" is a real thing she does, and the narrower
			   statement is the more recent intention. */
			day.Bands = append(day.Bands, opened[date]...)

			if got, ok := booked[date]; ok {
				day.Bookings = got
			}
			days = append(days, day)
		}

		writeJSON(w, 200, map[string]any{"ok": true, "days": days, "timezone": st.cfg.Timezone})
	}
}
