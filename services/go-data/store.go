package main

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ErrNotFound is returned for a handoff token that is unknown, already
// claimed, or expired — all three are indistinguishable to the caller
// on purpose, so the endpoint cannot be used to probe which tokens
// once existed.
var ErrNotFound = errors.New("not found")

type Store struct {
	pool *pgxpool.Pool
	cfg  Config

	/* ---- the client's own connection ------------------------------
	   A SECOND POOL, ON A SECOND ROLE, and the separation is
	   structural on purpose. The alternative — one pool and a flag
	   saying which kind of request this is — puts the boundary in a
	   variable somebody can forget to set, and the failure is
	   invisible. A different connection cannot be forgotten: a query
	   either runs on it or it does not.

	   It is the same pool as `pool` when DATABASE_URL_CLIENT is
	   unset, so every code path is exercised in both modes. The
	   difference is only whether the role it connects as is subject
	   to the row-level policies in schema.sql. */
	client *pgxpool.Pool

	// Whether `client` really is a separate, restricted role. Said at
	// boot, and answered by /health, so "RLS is on" is never a guess.
	rls bool

	/* The role DATABASE_URL_CLIENT actually connected as, read from
	   the connection rather than parsed out of the string. Said at
	   boot so the log reports what was verified, not what was set. */
	clientRole string
}

func NewStore(ctx context.Context, cfg Config) (*Store, error) {
	pool, err := openPool(ctx, cfg, cfg.DSN, "myf-go-data")
	if err != nil {
		return nil, err
	}

	/* The client's pool, when there is a separate role to run it on.
	   Sized smaller: this carries one person's own requests, and a
	   pool that can starve the practitioner's connection under a
	   burst of client traffic would make her CRM slow for a reason
	   she could never work out. */
	st := &Store{pool: pool, client: pool, cfg: cfg}

	if strings.TrimSpace(cfg.ClientDSN) != "" {
		cc := cfg
		cc.MaxConns = maxInt32(4, cfg.MaxConns/3)
		cc.MinConns = 1
		client, err := openPool(ctx, cc, cfg.ClientDSN, "myf-go-data-client")
		if err != nil {
			pool.Close()
			return nil, fmt.Errorf("client pool: %w", err)
		}
		who, err := verifyClientRole(ctx, client)
		if err != nil {
			client.Close()
			pool.Close()
			return nil, err
		}
		st.clientRole = who

		st.client = client
		st.rls = true
	}

	return st, nil
}

/* WHO DID THAT CONNECTION STRING ACTUALLY CONNECT AS?
 *
 * Until this existed, `rls = true` meant only that DATABASE_URL_CLIENT
 * was set to something — and the boot line said "row-level security:
 * ON" on that basis alone. A string pointing at the owner would have
 * satisfied it completely: the policies would all still be in the
 * database, none of them would apply, because an owner is exempt from
 * its own tables' policies unless the table says FORCE and deliberately
 * none of ours do. Nothing would look wrong. The app would work. One
 * client would see every client's rows.
 *
 * That is not a hypothetical slip. On a pooled connection the username
 * carries the project reference — `myf_client.abcdefgh` — and the one
 * the dashboard hands you, the one that belongs in DATABASE_URL, is
 * `postgres.abcdefgh`. The two strings differ by one word, in the
 * middle, and only one of them is a boundary.
 *
 * So the connection is asked who it is, and the answer has to be
 * somebody who cannot see past a policy. Fatal rather than a warning:
 * a warning in a boot log is a thing nobody reads on the day it
 * matters, and the failure it guards against is silent by nature. */
func verifyClientRole(ctx context.Context, client *pgxpool.Pool) (string, error) {
	var (
		who       string
		superuser bool
		bypassRLS bool
		owns      int
	)
	if err := client.QueryRow(ctx, `
		SELECT current_user,
		       coalesce((SELECT rolsuper     FROM pg_roles WHERE rolname = current_user), false),
		       coalesce((SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user), false),
		       (SELECT count(*) FROM pg_class c
		          JOIN pg_namespace n ON n.oid = c.relnamespace
		          JOIN pg_roles     o ON o.oid = c.relowner
		         WHERE n.nspname IN ('crm', 'public')
		           AND o.rolname = current_user)`,
	).Scan(&who, &superuser, &bypassRLS, &owns); err != nil {
		return "", fmt.Errorf("DATABASE_URL_CLIENT: cannot ask who it connects as: %w", err)
	}

	switch {
	case superuser:
		return "", fmt.Errorf(
			"DATABASE_URL_CLIENT connects as %q, which is a SUPERUSER — "+
				"every row-level policy would be inert. Refusing to start", who)
	case bypassRLS:
		return "", fmt.Errorf(
			"DATABASE_URL_CLIENT connects as %q, which has BYPASSRLS — "+
				"every row-level policy would be inert. Refusing to start", who)
	case owns > 0:
		return "", fmt.Errorf(
			"DATABASE_URL_CLIENT connects as %q, which OWNS %d table(s) in crm/public — "+
				"an owner is exempt from its own policies, so they would be inert. "+
				"Refusing to start", who, owns)
	}
	return who, nil
}

func maxInt32(a, b int32) int32 {
	if a > b {
		return a
	}
	return b
}

// One pool, built the same way whichever role it is for.
func openPool(ctx context.Context, cfg Config, dsn, appName string) (*pgxpool.Pool, error) {
	pc, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse DSN: %w", err)
	}

	pc.MaxConns = cfg.MaxConns
	pc.MinConns = cfg.MinConns
	pc.MaxConnLifetime = cfg.ConnLifetime
	pc.MaxConnIdleTime = cfg.ConnIdleTime
	// Spread recycling so a pool built in one burst does not expire in
	// one burst 30 minutes later and reconnect all at once.
	pc.MaxConnLifetimeJitter = cfg.ConnLifetime / 5
	pc.HealthCheckPeriod = 30 * time.Second

	// A server-side statement_timeout is the backstop that a client
	// context cannot provide: if the caller vanishes mid-query, Postgres
	// still stops the work rather than holding the connection.
	pc.ConnConfig.RuntimeParams["statement_timeout"] =
		fmt.Sprintf("%d", cfg.StmtTimeout.Milliseconds())
	pc.ConnConfig.RuntimeParams["application_name"] = appName

	pool, err := pgxpool.NewWithConfig(ctx, pc)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

func (s *Store) Close() {
	if s.client != nil && s.client != s.pool {
		s.client.Close()
	}
	s.pool.Close()
}

// RLS reports whether the client pool is genuinely a restricted role.
func (s *Store) RLS() bool { return s.rls }

// ClientRole is the role the client pool connected as, or "" when
// row-level security is off and both pools are the practitioner's.
func (s *Store) ClientRole() string { return s.clientRole }

/* ============================================================
   asClient — a client's own request, and nothing else's
   ------------------------------------------------------------
   Everything a client may read or write goes through here.

   IT IS A TRANSACTION BECAUSE IT HAS TO BE. `SET LOCAL` is scoped
   to a transaction and reverts on commit; a bare `SET` would
   persist on the pooled connection and hand the next request
   somebody else's identity. Outside a transaction `SET LOCAL`
   does nothing at all and warns, which would leave every policy
   evaluating against NULL and every query returning nothing —
   the safe failure, but a baffling one.

   THE IDENTITY IS NOT A PARAMETER TO THE QUERY. It is set on the
   session, so the policies see it whatever the query says. That
   is the entire point: a SELECT that forgets its WHERE clause
   returns this person's rows rather than everybody's.

   RESOLVING THE TOKEN HAPPENS BEFORE THIS, on the practitioner's
   pool. Working out who is asking is an authentication step, and
   authentication necessarily runs with more reach than the thing
   it authenticates — the same reason a login form can read the
   password table and a logged-in user cannot.
   ============================================================ */
func (s *Store) asClient(ctx context.Context, personID string, fn func(pgx.Tx) error) error {
	if personID == "" {
		// Never open the transaction at all. A blank identity would
		// set app.person_id to '' — which current_person() maps to
		// NULL and every policy then filters to nothing — so this is
		// already safe. It is refused here anyway, because reaching
		// this line with no person means a caller skipped the token
		// check, and that is worth failing loudly rather than
		// silently returning an empty list.
		return fmt.Errorf("asClient: no person")
	}

	tx, err := s.client.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	// set_config with a parameter rather than string interpolation:
	// SET LOCAL takes no placeholders, and a person id spliced into
	// SQL is an injection point on the one query that decides who
	// somebody is.
	if _, err := tx.Exec(ctx,
		`SELECT set_config('app.person_id', $1, true)`, personID); err != nil {
		return err
	}

	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ApplySchema runs schema.sql on boot. It is idempotent, so this is a
// safe substitute for a migration tool at trial scale — and it means
// a fresh clone plus a DATABASE_URL is all it takes to get running.
func (s *Store) ApplySchema(ctx context.Context, path string) error {
	sql, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("read %s: %w", path, err)
	}
	if _, err := s.pool.Exec(ctx, string(sql)); err != nil {
		return fmt.Errorf("apply: %w", err)
	}
	return nil
}

// ---- health ---------------------------------------------------------

type PoolStats struct {
	Total        int32 `json:"total"`
	Acquired     int32 `json:"acquired"`
	Idle         int32 `json:"idle"`
	Max          int32 `json:"max"`
	AcquireCount int64 `json:"acquireCount"`
	// EmptyAcquires is the number that matters under load: it counts
	// how often a caller had to WAIT for a connection. Non-zero and
	// climbing means the pool is the bottleneck, not Postgres.
	EmptyAcquires   int64  `json:"emptyAcquireCount"`
	CanceledAcquire int64  `json:"canceledAcquireCount"`
	AcquireDuration string `json:"totalAcquireWait"`
}

func (s *Store) Stats() PoolStats {
	st := s.pool.Stat()
	return PoolStats{
		Total:           st.TotalConns(),
		Acquired:        st.AcquiredConns(),
		Idle:            st.IdleConns(),
		Max:             st.MaxConns(),
		AcquireCount:    st.AcquireCount(),
		EmptyAcquires:   st.EmptyAcquireCount(),
		CanceledAcquire: st.CanceledAcquireCount(),
		AcquireDuration: st.AcquireDuration().String(),
	}
}

func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// ---- BMI ------------------------------------------------------------

type Snapshot struct {
	ID            string     `json:"id"`
	HeightCm      float64    `json:"heightCm"`
	WeightKg      float64    `json:"weightKg"`
	BMI           float64    `json:"bmi"`
	Category      string     `json:"category"`
	CategoryBasis string     `json:"categoryBasis"`
	AgeYears      *int       `json:"ageYears,omitempty"`
	Sex           *string    `json:"sex,omitempty"`
	Goal          *string    `json:"goal,omitempty"`
	Units         string     `json:"units"`
	CreatedAt     *time.Time `json:"createdAt,omitempty"`
}

// SaveSnapshot writes the calculation and mints a single-use handoff
// token in ONE transaction. If either half fails the visitor gets a
// clean error rather than a token pointing at nothing, or a snapshot
// nobody can reach.
func (s *Store) SaveSnapshot(ctx context.Context, in Snapshot, ipHash, ua string) (string, Snapshot, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", Snapshot{}, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op once committed

	var out Snapshot
	err = tx.QueryRow(ctx, `
		INSERT INTO bmi_snapshots
		  (height_cm, weight_kg, bmi, category, category_basis,
		   age_years, sex, goal, units, ip_hash, user_agent)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
		RETURNING id, height_cm, weight_kg, bmi, category, category_basis,
		          age_years, sex, goal, units, created_at`,
		in.HeightCm, in.WeightKg, in.BMI, in.Category, in.CategoryBasis,
		in.AgeYears, in.Sex, in.Goal, in.Units, ipHash, ua,
	).Scan(&out.ID, &out.HeightCm, &out.WeightKg, &out.BMI, &out.Category,
		&out.CategoryBasis, &out.AgeYears, &out.Sex, &out.Goal, &out.Units, &out.CreatedAt)
	if err != nil {
		return "", Snapshot{}, err
	}

	token, err := newToken()
	if err != nil {
		return "", Snapshot{}, err
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO handoff_tokens (token, snapshot_id, expires_at)
		VALUES ($1, $2, now() + $3::interval)`,
		token, out.ID, s.cfg.HandoffTTL.String(),
	); err != nil {
		return "", Snapshot{}, err
	}

	if err := tx.Commit(ctx); err != nil {
		return "", Snapshot{}, err
	}
	return token, out, nil
}

// ClaimHandoff exchanges a token for its snapshot, exactly once.
//
// The claim is an UPDATE with the guard in its WHERE clause, so two
// simultaneous claims cannot both succeed — the second matches no row.
// Doing this as SELECT-then-UPDATE would race.
func (s *Store) ClaimHandoff(ctx context.Context, token string) (Snapshot, error) {
	var snap Snapshot
	err := s.pool.QueryRow(ctx, `
		WITH claimed AS (
		  UPDATE handoff_tokens
		     SET claimed_at = now()
		   WHERE token = $1
		     AND claimed_at IS NULL
		     AND expires_at > now()
		  RETURNING snapshot_id
		)
		SELECT s.id, s.height_cm, s.weight_kg, s.bmi, s.category,
		       s.category_basis, s.age_years, s.sex, s.goal, s.units
		  FROM bmi_snapshots s
		  JOIN claimed c ON c.snapshot_id = s.id`, token,
	).Scan(&snap.ID, &snap.HeightCm, &snap.WeightKg, &snap.BMI, &snap.Category,
		&snap.CategoryBasis, &snap.AgeYears, &snap.Sex, &snap.Goal, &snap.Units)

	if errors.Is(err, pgx.ErrNoRows) {
		return Snapshot{}, ErrNotFound
	}
	return snap, err
}

// ---- appointments ---------------------------------------------------

type Appointment struct {
	ID             string          `json:"id,omitempty"`
	Reference      string          `json:"reference"`
	Name           string          `json:"name"`
	Email          string          `json:"email"`
	Phone          *string         `json:"phone,omitempty"`
	FocusArea      string          `json:"focusArea"`
	DOB            *string         `json:"dob,omitempty"`
	Country        *string         `json:"country,omitempty"`
	Mode           string          `json:"mode"`
	Notes          *string         `json:"notes,omitempty"`
	SuggestedSlots json.RawMessage `json:"suggestedSlots,omitempty"`
	SnapshotID     *string         `json:"snapshotId,omitempty"`
	Source         string          `json:"source"`
	Status         string          `json:"status,omitempty"`
	PolicyVersion  *string         `json:"policyVersion,omitempty"`
	CreatedAt      *time.Time      `json:"createdAt,omitempty"`
	BMI            *float64        `json:"bmi,omitempty"`
}

func (s *Store) SaveAppointment(ctx context.Context, a Appointment) (Appointment, error) {
	if len(a.SuggestedSlots) == 0 {
		a.SuggestedSlots = json.RawMessage(`[]`)
	}
	if a.Mode == "" {
		a.Mode = "undecided"
	}
	if a.Source == "" {
		a.Source = "trial"
	}

	var out Appointment
	err := s.pool.QueryRow(ctx, `
		INSERT INTO appointments
		  (reference, name, email, phone, focus_area, dob, country,
		   mode, notes, suggested_slots, snapshot_id, source, policy_version)
		VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13)
		RETURNING id, reference, created_at, status`,
		a.Reference, a.Name, a.Email, a.Phone, a.FocusArea, a.DOB, a.Country,
		a.Mode, a.Notes, a.SuggestedSlots, a.SnapshotID, a.Source, a.PolicyVersion,
	).Scan(&out.ID, &out.Reference, &out.CreatedAt, &out.Status)
	// RETURNING only carries what the database generated. Echoing back
	// blank name and email made a successful write look like it had
	// dropped the payload — so the caller's own values are copied onto
	// the result rather than left as zero.
	out.Name, out.Email, out.FocusArea = a.Name, a.Email, a.FocusArea
	out.Phone, out.Country, out.DOB = a.Phone, a.Country, a.DOB
	out.Mode, out.Source, out.SnapshotID = a.Mode, a.Source, a.SnapshotID
	out.SuggestedSlots = a.SuggestedSlots
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return Appointment{}, fmt.Errorf("reference %q already used", a.Reference)
		}
		return Appointment{}, err
	}
	return out, nil
}

// RecentAppointments is for eyeballing the trial, so it joins the BMI
// straight in — the whole point of this schema is that the two are
// connected, and a list that made you look them up separately would
// not be demonstrating anything.
func (s *Store) RecentAppointments(ctx context.Context, limit int) ([]Appointment, error) {
	if limit <= 0 || limit > 200 {
		limit = 25
	}
	rows, err := s.pool.Query(ctx, `
		SELECT a.id, a.reference, a.name, a.email, a.focus_area, a.mode,
		       a.country, a.status, a.source, a.created_at, a.suggested_slots,
		       s.bmi
		  FROM appointments a
		  LEFT JOIN bmi_snapshots s ON s.id = a.snapshot_id
		 ORDER BY a.created_at DESC
		 LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]Appointment, 0, limit)
	for rows.Next() {
		var a Appointment
		if err := rows.Scan(&a.ID, &a.Reference, &a.Name, &a.Email, &a.FocusArea,
			&a.Mode, &a.Country, &a.Status, &a.Source, &a.CreatedAt,
			&a.SuggestedSlots, &a.BMI); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) PurgeExpired(ctx context.Context) (int, error) {
	var n int
	err := s.pool.QueryRow(ctx, `SELECT purge_expired_handoffs()`).Scan(&n)
	return n, err
}

/* ============================================================
   ReleaseExpiredHolds — give the hour back
   ------------------------------------------------------------
   An hour is reserved while somebody is at the checkout. If they
   wander off, nothing until now gave it back: the row stayed
   'held' with a time on it, and consultations_slot_unique counts
   'held' — so one abandoned browser tab blocked that Tuesday
   morning for good. Every abandoned checkout permanently removed
   an hour from her week.

   WHAT COUNTS AS ABANDONED is already written into the schema and
   did not need a new column. hold_expires_at is set when a slot is
   taken and set back to NULL the moment she answers — see the
   UPDATE in crmConsultationDecide. So a hold_expires_at that is
   still set and already past means nobody ever answered.

   SCOPED TO HOLDS THAT ACTUALLY OCCUPY AN HOUR. A request with no
   time on it is somebody waiting for her to offer one; it blocks
   nothing and is not the system's to cancel. Hence the
   scheduled_start_at IS NOT NULL — without it this would quietly
   bin her Requests queue on a timer.

   CANCELLED, NOT DELETED. They tried to book and it lapsed; that
   is worth being able to see. Cancelled is outside the partial
   index, so the hour is free again the moment this runs.
   ============================================================ */
func (s *Store) ReleaseExpiredHolds(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE crm.consultations
		   SET status          = 'cancelled',
		       hold_expires_at = NULL,
		       updated_at      = now()
		 WHERE status               = 'held'
		   AND scheduled_start_at IS NOT NULL
		   AND hold_expires_at    IS NOT NULL
		   AND hold_expires_at     < now()`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ---- helpers --------------------------------------------------------

func newToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return strings.TrimRight(base64.URLEncoding.EncodeToString(b), "="), nil
}
