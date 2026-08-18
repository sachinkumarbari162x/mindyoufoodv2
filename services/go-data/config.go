package main

import (
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

// Config is read once at boot. Every value has a working default, so
// the service runs on a bare `go run .` with nothing but DATABASE_URL.
type Config struct {
	Port       string
	DSN        string
	SchemaPath string

	/* THE CLIENT'S OWN CONNECTION, on a role that owns nothing and is
	   subject to every row-level policy in schema.sql.

	   Unset is the correct default for a fresh clone: Go then runs
	   both connections as the practitioner and row-level security is
	   inert. That is announced at boot rather than left to be
	   discovered, because a boundary that looks active and is not is
	   worse than no boundary at all. */
	ClientDSN string

	MaxConns     int32
	MinConns     int32
	ConnLifetime time.Duration
	ConnIdleTime time.Duration
	StmtTimeout  time.Duration

	HandoffTTL time.Duration
	PurgeEvery time.Duration

	/* ---- the consultation, and when it may be offered ----
	   Read from the SAME environment variables the Node service
	   reads, so the engine that decides a slot is free and the desk
	   that offers it can never disagree about how long a session is.
	   Settled 2026-08-12: 60 minutes, no gap, three a day. */
	Timezone       string
	ConsultMinutes int
	BufferMinutes  int
	MaxPerDay      int
	MinLeadHours   int
	MaxHorizonDays int
}

func loadConfig() Config {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		// Fatal rather than a fallback DSN: a data service that silently
		// points somewhere unexpected is worse than one that will not start.
		panic("DATABASE_URL is not set — see .env in the project root")
	}

	exe, _ := os.Executable()
	schema := os.Getenv("SCHEMA_PATH")
	if schema == "" {
		// Next to the source when run with `go run`, next to the binary
		// when built. Both are checked at apply time.
		if wd, err := os.Getwd(); err == nil {
			schema = filepath.Join(wd, "schema.sql")
		} else {
			schema = filepath.Join(filepath.Dir(exe), "schema.sql")
		}
	}

	return Config{
		Port:       env("GO_DATA_PORT", "5504"),
		DSN:        dsn,
		ClientDSN:  os.Getenv("DATABASE_URL_CLIENT"),
		SchemaPath: schema,

		// 25 is deliberate. Postgres' default max_connections is 100 and
		// it is shared with everything else on the box — psql sessions,
		// the practitioner's tooling, whatever else runs here. A pool
		// that can eat the whole server is a pool that takes the server
		// down under exactly the load it was sized for.
		MaxConns:     int32(envInt("DB_MAX_CONNS", 25)),
		MinConns:     int32(envInt("DB_MIN_CONNS", 2)),
		ConnLifetime: envDur("DB_CONN_LIFETIME", 30*time.Minute),
		ConnIdleTime: envDur("DB_CONN_IDLE", 5*time.Minute),
		// A query that has not returned in 5s is not going to help the
		// visitor waiting on it, and it is holding a pooled connection.
		StmtTimeout: envDur("DB_STATEMENT_TIMEOUT", 5*time.Second),

		// Long enough to read a BMI result and decide to book; short
		// enough that an abandoned token is gone quickly.
		HandoffTTL: envDur("HANDOFF_TTL", 30*time.Minute),

		// Same names and same defaults as services/node-bff/config.js.
		Timezone:       env("PRACTICE_TZ", "Asia/Kolkata"),
		ConsultMinutes: envInt("CONSULT_MINUTES", 60),
		BufferMinutes:  envInt("CONSULT_BUFFER_MINUTES", 0),
		MaxPerDay:      envInt("CONSULT_MAX_PER_DAY", 3),
		MinLeadHours:   envInt("MIN_LEAD_HOURS", 12),
		MaxHorizonDays: envInt("MAX_HORIZON_DAYS", 60),
		PurgeEvery:     envDur("PURGE_EVERY", 10*time.Minute),
	}
}

// DBName is for logging — it must never expose the password.
func (c Config) DBName() string {
	u, err := url.Parse(c.DSN)
	if err != nil {
		return "«unparseable»"
	}
	name := u.Path
	if len(name) > 0 && name[0] == '/' {
		name = name[1:]
	}
	return u.Hostname() + ":" + u.Port() + "/" + name
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envDur(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
	}
	return def
}
