// MIGRATIONS — ordered, recorded, and refused when they change.
//
// `schema.sql` still runs first and still describes the base tables
// idempotently. It cannot express a CHANGE, though: adding a column,
// widening a CHECK, creating an index that has to exist exactly once.
// Those need to run in order, once each, and be remembered.
//
// That is all this is. No migration tool, no dependency, matching the
// rest of the service:
//
//	db/migrations/NNNN_name.sql   ordered by filename
//	schema_migrations             which have run, and their checksum
//
// Each file runs inside its own transaction, so a migration that
// fails half way leaves nothing behind. Files are EMBEDDED in the
// binary rather than read from disk — the schema.sql path already has
// to be guessed from the working directory, and a deployment that
// silently finds no migrations would be far worse than one that fails
// to start.
package main

import (
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
)

//go:embed db/migrations/*.sql
var migrationFS embed.FS

type migration struct {
	version  string // "0001_scheduling"
	sql      string
	checksum string
}

func loadMigrations() ([]migration, error) {
	entries, err := migrationFS.ReadDir("db/migrations")
	if err != nil {
		return nil, fmt.Errorf("read migrations: %w", err)
	}

	out := make([]migration, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		body, err := migrationFS.ReadFile("db/migrations/" + e.Name())
		if err != nil {
			return nil, fmt.Errorf("read %s: %w", e.Name(), err)
		}
		sum := sha256.Sum256(body)
		out = append(out, migration{
			version:  strings.TrimSuffix(e.Name(), ".sql"),
			sql:      string(body),
			checksum: hex.EncodeToString(sum[:]),
		})
	}

	// Filenames are zero-padded, so lexical order is numeric order.
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	return out, nil
}

// Migrate applies everything not yet recorded, in order, and returns
// the versions it ran. Applying nothing is the normal case and is not
// an error.
func (s *Store) Migrate(ctx context.Context) ([]string, error) {
	if _, err := s.pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    text PRIMARY KEY,
			checksum   text NOT NULL,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`); err != nil {
		return nil, fmt.Errorf("schema_migrations: %w", err)
	}

	applied := map[string]string{}
	rows, err := s.pool.Query(ctx, `SELECT version, checksum FROM schema_migrations`)
	if err != nil {
		return nil, fmt.Errorf("read applied: %w", err)
	}
	for rows.Next() {
		var v, c string
		if err := rows.Scan(&v, &c); err != nil {
			rows.Close()
			return nil, err
		}
		applied[v] = c
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	all, err := loadMigrations()
	if err != nil {
		return nil, err
	}

	var ran []string
	for _, m := range all {
		if was, seen := applied[m.version]; seen {
			// Editing a migration that has already run means the database
			// no longer matches the file that supposedly describes it.
			// Refuse to start rather than paper over the difference: the
			// fix is a new migration, never a rewritten one.
			if was != m.checksum {
				return nil, fmt.Errorf(
					"migration %s was already applied with different contents — "+
						"add a new migration instead of editing this one", m.version)
			}
			continue
		}

		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return nil, fmt.Errorf("begin %s: %w", m.version, err)
		}
		if _, err := tx.Exec(ctx, m.sql); err != nil {
			tx.Rollback(ctx)
			return nil, fmt.Errorf("apply %s: %w", m.version, err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)`,
			m.version, m.checksum); err != nil {
			tx.Rollback(ctx)
			return nil, fmt.Errorf("record %s: %w", m.version, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return nil, fmt.Errorf("commit %s: %w", m.version, err)
		}
		ran = append(ran, m.version)
	}

	return ran, nil
}
