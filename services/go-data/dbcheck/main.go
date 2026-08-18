// dbcheck — proves the scheduling schema does what it claims.
//
//	go run ./dbcheck
//
// The double-booking guard is a partial unique index, which means it
// is invisible in normal use and only earns its keep at the exact
// moment two writes collide. That is not something to take on trust,
// so this drives it directly: two visitors, one slot, and the second
// write must be refused by Postgres rather than by any Go code.
//
// Writes to the trial database and removes everything it created.
package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const marker = "dbcheck-" // every row this tool creates is prefixed

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		fmt.Println("DATABASE_URL is not set")
		os.Exit(1)
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	must(err, "connect")
	defer pool.Close()

	defer cleanup(ctx, pool)
	cleanup(ctx, pool) // in case a previous run was interrupted

	section("schema")
	for _, name := range []string{
		"availability_rules", "availability_exceptions",
		"notifications", "schema_migrations",
	} {
		var exists bool
		must(pool.QueryRow(ctx,
			`SELECT to_regclass($1) IS NOT NULL`, "public."+name).Scan(&exists), "table "+name)
		report(exists, "table "+name)
	}
	for _, name := range []string{"appointments_slot_unique", "notifications_once"} {
		var exists bool
		must(pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = $1)`, name).Scan(&exists), "index "+name)
		report(exists, "index "+name)
	}

	var modes string
	must(pool.QueryRow(ctx, `
		SELECT pg_get_constraintdef(oid) FROM pg_constraint
		WHERE conname = 'appointments_mode_check'`).Scan(&modes), "mode check")
	report(strings.Contains(modes, "audio"), "mode 'audio' accepted")

	var statuses string
	must(pool.QueryRow(ctx, `
		SELECT pg_get_constraintdef(oid) FROM pg_constraint
		WHERE conname = 'appointments_status_check'`).Scan(&statuses), "status check")
	report(strings.Contains(statuses, "held"), "status 'held' accepted")

	// ---- the guard -------------------------------------------------
	section("two visitors, one slot")
	slot := time.Now().Add(72 * time.Hour).Truncate(time.Hour)

	id1, err := book(ctx, pool, "one", slot, "held")
	report(err == nil, "first visitor holds the slot")
	if err != nil {
		fmt.Println("   unexpected:", err)
		os.Exit(1)
	}

	_, err = book(ctx, pool, "two", slot, "held")
	report(err != nil && strings.Contains(err.Error(), "appointments_slot_unique"),
		"second visitor is REFUSED by the database")
	if err == nil {
		fmt.Println("   DOUBLE BOOKED — the guard is not working")
		os.Exit(1)
	}

	// A released slot has to become bookable again, or one abandoned
	// hold would block that hour forever.
	_, err = pool.Exec(ctx, `UPDATE appointments SET status='cancelled' WHERE id=$1`, id1)
	must(err, "cancel")
	_, err = book(ctx, pool, "three", slot, "held")
	report(err == nil, "after cancelling, the slot frees up again")

	// ---- send once -------------------------------------------------
	section("one message per appointment per kind")
	id, err := book(ctx, pool, "four", slot.Add(2*time.Hour), "confirmed")
	must(err, "book for notify")
	must(notify(ctx, pool, id), "first confirmation")
	report(true, "confirmation recorded")
	report(notify(ctx, pool, id) != nil, "a second confirmation is REFUSED")

	// ---- the crm schema ---------------------------------------------
	section("crm schema")
	for _, name := range []string{"crm.countries", "crm.people", "crm.consultations"} {
		var exists bool
		must(pool.QueryRow(ctx, `SELECT to_regclass($1) IS NOT NULL`, name).Scan(&exists), name)
		report(exists, "table "+name)
	}

	var countries int
	must(pool.QueryRow(ctx, `SELECT count(*) FROM crm.countries`).Scan(&countries), "countries")
	report(countries >= 70, fmt.Sprintf("%d countries seeded", countries))

	// The dropdown order: her four, then the rest alphabetically.
	rows, err := pool.Query(ctx, `
		SELECT name FROM crm.countries
		ORDER BY priority NULLS LAST, name LIMIT 6`)
	must(err, "order")
	var order []string
	for rows.Next() {
		var n string
		rows.Scan(&n)
		order = append(order, n)
	}
	rows.Close()
	want := []string{"United Kingdom", "United States", "Saudi Arabia", "India"}
	ok := len(order) >= 4
	for i := range want {
		if ok && order[i] != want[i] {
			ok = false
		}
	}
	report(ok, "her four pin to the top: "+strings.Join(order[:min(4, len(order))], ", "))
	report(len(order) > 4, "then the rest follow: "+strings.Join(order[4:], ", ")+" …")

	// One person, however many times they book.
	section("one record per person")
	var p1, p2 string
	must(pool.QueryRow(ctx, `
		INSERT INTO crm.people (name, email, country_iso2, source)
		VALUES ($1, $2, 'IN', 'dbcheck') RETURNING id`,
		marker+"person", marker+"person@example.invalid").Scan(&p1), "insert person")

	err = pool.QueryRow(ctx, `
		INSERT INTO crm.people (name, email, country_iso2, source)
		VALUES ($1, $2, 'GB', 'dbcheck') RETURNING id`,
		marker+"person", strings.ToUpper(marker+"person@example.invalid")).Scan(&p2)
	report(err != nil, "the same email in different case is REFUSED as a duplicate")

	_, err = pool.Exec(ctx, `
		INSERT INTO crm.consultations (person_id, issue, mode)
		VALUES ($1, 'PCOS', 'video')`, p1)
	report(err == nil, "a consultation attaches to that person")

	fmt.Println("\nall checks passed")
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func book(ctx context.Context, pool *pgxpool.Pool, who string, at time.Time, status string) (string, error) {
	var id string
	err := pool.QueryRow(ctx, `
		INSERT INTO appointments
			(reference, name, email, focus_area, mode, status,
			 scheduled_start_at, scheduled_end_at)
		VALUES ($1, $2, $3, 'PCOS', 'audio', $4, $5, $6)
		RETURNING id`,
		marker+who, marker+who, marker+who+"@example.invalid", status,
		at, at.Add(time.Hour),
	).Scan(&id)
	return id, err
}

func notify(ctx context.Context, pool *pgxpool.Pool, appointmentID string) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO notifications
			(appointment_id, kind, recipient, template_id, template_version, body)
		VALUES ($1, 'confirmed', $2, 'confirmed-audio', '1', 'test body')`,
		appointmentID, marker+"four@example.invalid")
	return err
}

func cleanup(ctx context.Context, pool *pgxpool.Pool) {
	pool.Exec(ctx, `DELETE FROM appointments WHERE reference LIKE $1`, marker+"%")
	// Consultations go with their person, via ON DELETE CASCADE.
	pool.Exec(ctx, `DELETE FROM crm.people WHERE email LIKE $1`, marker+"%")
}

func section(s string) { fmt.Printf("\n%s\n", strings.ToUpper(s)) }

func report(ok bool, what string) {
	mark := "FAIL"
	if ok {
		mark = "ok"
	}
	fmt.Printf("  %-6s %s\n", mark, what)
	if !ok {
		os.Exit(1)
	}
}

func must(err error, what string) {
	if err != nil {
		fmt.Printf("  FAIL   %s: %v\n", what, err)
		os.Exit(1)
	}
}
