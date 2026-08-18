/* ============================================================
   CONFIGURATION — applied by the system, not by hand
   ------------------------------------------------------------
   The metric registry, the units and the client questions were
   written as psql files and applied by typing psql. That is fine
   on a laptop and wrong everywhere else: a deployment to
   Lightsail or Supabase would come up with an EMPTY registry, no
   units, and no answers on the client's Questions screen — and
   nothing would say so. Every screen that reads them would draw
   an empty state that looks exactly like a practice which has
   not filled anything in yet.

   So they run at boot, next to the migrations.

   THEY ARE NOT MIGRATIONS, AND THE DIFFERENCE MATTERS.

     A migration runs ONCE and is remembered. Editing one after
     it has run is refused, because the database no longer
     matches the file that claims to describe it.

     Configuration is re-asserted EVERY BOOT. Adding a metric to
     the catalogue, correcting a unit factor or rewriting an
     answer should arrive with the next deploy without anybody
     inventing a migration number for it. Every statement in
     these files is an idempotent upsert, and each one says in
     its own header which columns it deliberately does NOT
     overwrite — `crm.settings.value` is the important one, so a
     redeploy cannot put her chosen unit standard back to the
     default.

   THE LIST IS EXPLICIT, NOT A GLOB. `db/config.sql` and
   `db/dump.sql` sit in the same directory and are a different
   kind of thing entirely — COPY blocks holding a practice's
   actual rows. A `db/config_*.sql` pattern would have swept
   config.sql in, and pgx cannot execute a COPY … FROM stdin at
   all. Naming the three files means adding a fourth is a
   decision somebody makes rather than a filename they happen to
   choose.
   ============================================================ */
package main

import (
	"context"
	"embed"
	"fmt"
	"regexp"
	"strings"
)

//go:embed db/config_units.sql db/config_metrics.sql db/config_client_questions.sql
var configFS embed.FS

/* Order matters in one place: metrics reference dimensions that
   units defines. Nothing enforces it in the database — the
   dimension is text on both sides on purpose, so a metric can be
   catalogued before its unit exists — but applying them the
   right way round means a fresh database is never briefly
   inconsistent. */
var configFiles = []string{
	"db/config_units.sql",
	"db/config_metrics.sql",
	"db/config_client_questions.sql",
}

/* PSQL META-COMMANDS ARE NOT SQL. `\set`, `\echo` and friends are
   instructions to the psql CLIENT and mean nothing to a server
   connection — pgx returns a syntax error on the backslash.

   They stay in the files, because running these by hand with
   psql has to keep working: `\set ON_ERROR_STOP on` is what makes
   a manual run stop at the first mistake instead of ploughing on.
   They are simply skipped here. */
var psqlMeta = regexp.MustCompile(`(?m)^\s*\\[a-zA-Z]+.*$`)

/* And the transaction markers go too. Each file wraps itself in
   BEGIN/COMMIT for the psql path; here the whole file already
   runs inside a transaction this function opened, and a nested
   COMMIT would end it early and leave the rest of the file
   running unprotected. */
var txMarkers = regexp.MustCompile(`(?mi)^\s*(BEGIN|COMMIT|ROLLBACK)\s*;\s*$`)

func sqlOnly(body string) string {
	out := psqlMeta.ReplaceAllString(body, "")
	out = txMarkers.ReplaceAllString(out, "")
	return strings.TrimSpace(out)
}

/*
ApplyConfig runs the configuration files, every boot, each in its
own transaction.

Returns what it applied, for the boot log. A file that fails stops
the service: an empty metric registry is not a degraded mode, it
is a system where every number has lost its name, and starting
anyway would hide that until somebody opened a screen.
*/
func (s *Store) ApplyConfig(ctx context.Context) ([]string, error) {
	applied := make([]string, 0, len(configFiles))

	for _, name := range configFiles {
		body, err := configFS.ReadFile(name)
		if err != nil {
			return applied, fmt.Errorf("read %s: %w", name, err)
		}

		statements := sqlOnly(string(body))
		if statements == "" {
			continue
		}

		tx, err := s.pool.Begin(ctx)
		if err != nil {
			return applied, fmt.Errorf("begin %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, statements); err != nil {
			tx.Rollback(ctx)
			return applied, fmt.Errorf("apply %s: %w", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return applied, fmt.Errorf("commit %s: %w", name, err)
		}

		applied = append(applied, strings.TrimSuffix(strings.TrimPrefix(name, "db/config_"), ".sql"))
	}

	return applied, nil
}

/* What the boot log should say. Counted rather than listed,
   because "the registry has 187 metrics in it" is the fact worth
   seeing on a deploy — a number that is suddenly zero or
   suddenly half says something went wrong far more clearly than
   a list of filenames. */
func (s *Store) ConfigSummary(ctx context.Context) string {
	var metrics, units, standards, questions int
	_ = s.pool.QueryRow(ctx, `SELECT count(*) FROM crm.metric_defs WHERE active`).Scan(&metrics)
	_ = s.pool.QueryRow(ctx, `SELECT count(*) FROM crm.units`).Scan(&units)
	_ = s.pool.QueryRow(ctx, `SELECT count(*) FROM crm.unit_standards`).Scan(&standards)
	_ = s.pool.QueryRow(ctx,
		`SELECT count(*) FROM crm.knowledge WHERE audience = 'client' AND active`).Scan(&questions)

	return fmt.Sprintf("%d metrics · %d units in %d standards · %d client answers",
		metrics, units, standards, questions)
}
