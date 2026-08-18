// Command go-data is the trial data service for Mind Your Food.
//
// It exists for one reason: Postgres connections are expensive and
// finite, and the Node BFF is a single-threaded process that should
// not be managing a pool of them. This service owns the pool, keeps
// connections warm, and serves the BFF over loopback — so a burst of
// visitors becomes a queue in front of a pool rather than a stampede
// of new backends against Postgres.
//
//	GET  /health                 pool stats + a real round trip
//	POST /bmi                    store a snapshot, return a handoff token
//	POST /handoff/claim          exchange a token for its snapshot (once)
//	POST /appointments           persist a trial appointment
//	GET  /appointments/recent    newest first, for eyeballing the trial
//
// Every handler carries a context deadline. Nothing here talks to the
// production database; see schema.sql.
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	log.SetFlags(log.Ltime)

	cfg := loadConfig()

	// A generous ceiling on startup: if Postgres is not up yet we want
	// a clear error, not a service that binds a port and then fails
	// every request.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	store, err := NewStore(ctx, cfg)
	if err != nil {
		log.Fatalf("[go-data] cannot reach Postgres: %v", err)
	}
	defer store.Close()

	if err := store.ApplySchema(ctx, cfg.SchemaPath); err != nil {
		log.Fatalf("[go-data] schema: %v", err)
	}

	// Then anything schema.sql cannot express — column additions,
	// widened constraints, the unique index that stops two visitors
	// taking the same slot. Ordered, recorded, and refused if an
	// already-applied file has been edited. See migrate.go.
	ran, err := store.Migrate(ctx)
	if err != nil {
		log.Fatalf("[go-data] migrate: %v", err)
	}
	if len(ran) > 0 {
		log.Printf("[go-data] applied %d migration(s): %v", len(ran), ran)
	}

	/* And the configuration — the metric registry, the units and
	   the answers on the client's Questions screen. Re-asserted
	   every boot rather than once, so correcting a unit factor or
	   adding a metric arrives with the deploy. See config_apply.go
	   for why these are not migrations. */
	if _, err := store.ApplyConfig(ctx); err != nil {
		log.Fatalf("[go-data] config: %v", err)
	}
	log.Printf("[go-data] configuration: %s", store.ConfigSummary(ctx))

	srv := &http.Server{
		Addr:    "127.0.0.1:" + cfg.Port,
		Handler: routes(store),
		// A slow client must not be able to hold a goroutine, and
		// through it a pooled connection, open indefinitely.
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      20 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// Expired handoff tokens carry body measurements. Sweep them.
	stop := make(chan struct{})
	go func() {
		t := time.NewTicker(cfg.PurgeEvery)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				c, cc := context.WithTimeout(context.Background(), 10*time.Second)
				if n, err := store.PurgeExpired(c); err != nil {
					log.Printf("[go-data] purge failed: %v", err)
				} else if n > 0 {
					log.Printf("[go-data] purged %d expired handoff(s)", n)
				}
				/* And give back any hour somebody reserved at a
				   checkout and then wandered off from. Until this
				   ran, one abandoned browser tab blocked that slot
				   for good. */
				if n, err := store.ReleaseExpiredHolds(c); err != nil {
					log.Printf("[go-data] releasing holds failed: %v", err)
				} else if n > 0 {
					log.Printf("[go-data] released %d expired hold(s)", n)
				}
				cc()
			case <-stop:
				return
			}
		}
	}()

	go func() {
		log.Printf("[go-data] listening on http://127.0.0.1:%s", cfg.Port)
		log.Printf("[go-data] pool: max=%d min=%d db=%s", cfg.MaxConns, cfg.MinConns, cfg.DBName())

		/* SAID OUT LOUD, because the failure this guards against is
		   silent. With DATABASE_URL_CLIENT unset the policies from
		   schema.sql are all still in the database and none of
		   them apply — the system looks protected and is not. A line
		   at boot is the difference between knowing and assuming. */
		if store.RLS() {
			log.Printf("[go-data] row-level security: ON — a client's requests run as %s, "+
				"checked at boot: not a superuser, no BYPASSRLS, owns nothing",
				store.ClientRole())
		} else {
			log.Printf("[go-data] row-level security: OFF — set DATABASE_URL_CLIENT to enforce it. " +
				"Client requests run as the practitioner and every policy is inert.")
		}
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[go-data] listen: %v", err)
		}
	}()

	// Drain in flight requests before dropping the pool, so a booking
	// mid-write is not lost to a restart.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	close(stop)

	log.Println("[go-data] shutting down…")
	shutCtx, shutCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutCancel()
	if err := srv.Shutdown(shutCtx); err != nil {
		log.Printf("[go-data] forced close: %v", err)
	}
	log.Println("[go-data] stopped")
}
