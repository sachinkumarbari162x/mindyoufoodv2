# Moving the database to Supabase

> The project ref is written as `<project-ref>` throughout. It used to
> be spelled out here, and it should not have been: this file ships in a
> public deployment repository, and the ref is the username half of the
> database credential -- it names the host and the account, leaving only
> the password between a stranger and every client record. Take the real
> value from the Supabase dashboard, and keep it in `.env.prod`.

There is no migration to write. `go-data` builds its own schema on
boot — `schema.sql`, then anything in `db/migrations/` — so pointing it
at an empty Supabase database and starting it is most of the "push".
Rehearsed locally against a database created from nothing: 35 tables,
113 indexes, 127 constraints and all 11 row-level policies, in one
boot.

The schema carries **no rows**, so there are two files to load
afterwards, and one of them is not optional.

What follows is the order, and the places it can go quietly wrong.

## 1. Session mode on the pooler — checked, not assumed

Supabase offers three ways in, and for **this project** only one of
them works. Measured against `<project-ref>` on 2026-08-16:

| | host / port | |
|---|---|---|
| Direct | `db.<ref>.supabase.co:5432` | **unreachable** |
| Pooler, session | `aws-0-ap-south-1.pooler.supabase.com:5432` | **use this** |
| Pooler, transaction | `…:6543` | reachable, wrong |

**The direct connection has no IPv4 address at all** — only an `AAAA`
record — and Supabase now charges for the IPv4 add-on. It did not
answer on port 5432 even from a machine that has a global IPv6 address
of its own. So the obvious-looking choice is not available, and finding
that out during a deploy rather than before it is the whole reason this
section is here.

Between the two pooler ports the difference matters:

- **Session mode, 5432.** The connection gets a dedicated backend for
  as long as it is held. Prepared statements survive, and so does a
  transaction. This behaves like a direct connection, which is what
  `go-data` needs.
- **Transaction mode, 6543.** A backend is handed back between
  transactions. pgx prepares statements by name and expects to find
  them again; it will not. It would need
  `default_query_exec_mode=simple_protocol` and no statement cache —
  slower, and a constraint nobody would remember six months from now.

There is a second reason session mode is the right one. A client's
request is scoped by `set_config('app.person_id', …, true)`, which
lives for exactly one transaction. That is safe in either mode, but
only session mode also guarantees the pool behaves the way `store.go`
assumes when it hands the same connection back for a follow-up query.

The pool is ours already (25 connections, `DB_MAX_CONNS`), so the
pooler is not solving a problem we have — it is simply the only route
in that has an IPv4 address.

**The username changes in pooler mode.** It carries the project
reference: `postgres.<project-ref>`, not plain `postgres`.
Getting this wrong gives a "Tenant or user not found" that looks
nothing like a username problem.

## 2. `DATABASE_URL`, and let it build the schema

```
DATABASE_URL=postgres://postgres.<project-ref>:PASSWORD@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require
```

Note the three things section 1 established: the **pooler** host, port
**5432** for session mode, and the username carrying the **project
ref**.

`sslmode=require` is not optional — this is a connection across the
public internet, not a loopback socket.

The password is not the anon key and cannot be derived from it. It is
set once, in the dashboard, under **Project Settings → Database →
Database password**, and shown in full only at that moment.

Start the stack. The boot log names the database and lists what it
applied:

```
[go-data] applied 1 migration(s): [0001_after_the_rewrite]
[go-data] pool: max=25 min=2 db=aws-0-ap-south-1.pooler.supabase.com:5432/postgres
[go-data] row-level security: OFF — set DATABASE_URL_CLIENT to enforce it.
```

`OFF` is correct at this point. `schema.sql` has created `myf_client`
with `NOLOGIN` and hung eleven policies off it; none of them can apply
until something actually connects as that role.

## 3. The rows the system cannot work without

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/config.sql
```

The country list the booking form offers, what the front desk knows how
to answer, her weekly hours. Skipping this leaves a database with a
perfect schema and a site that cannot take a booking, which is a harder
fault to recognise than an outright failure.

It contains no staff row — see step 6.

## 4. Give `myf_client` a password

```
psql "$DATABASE_URL" -v pw="'<a long random string>'" -f db/roles.sql
```

The quoting is exact: the value of `-v` must contain its own single
quotes, because psql substitutes it literally.

**Expect this, and do not be alarmed by it:**

```
NOTICE:  Not a superuser here, so the hardening ALTER was refused.
         That is expected on a managed database and is not a problem:
         the attributes default to off and the check below proves it.
NOTICE:  myf_client: can log in, not a superuser, no BYPASSRLS,
         owns nothing. Good.
```

Supabase's `postgres` can create roles but is not a real superuser, so
it may not set `SUPERUSER` or `BYPASSRLS` on anything — which is also
the reason nothing else there can turn them *on*. The script tries the
hardening, tolerates the refusal, and then **checks** rather than
assumes: if `myf_client` were a superuser, held `BYPASSRLS`, or owned
so much as one table, it raises and stops. Any of the three would make
all eleven policies decorative.

That path is tested. `scratchpad/roles-check.test.cjs` reproduces this
exact shape locally — a `CREATEROLE` role that is not a superuser —
and requires each sabotage to be refused.

## 5. `DATABASE_URL_CLIENT`, and confirm it took

```
DATABASE_URL_CLIENT=postgres://myf_client.<project-ref>:THAT_PASSWORD@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require
```

**Read that username again.** The pooler's format is
`<database-user>.<project-ref>`, so this one is
`myf_client.<project-ref>` — the *role* is the part before the
dot. Writing `postgres.<project-ref>` here, which is what the
dashboard hands you and what step 2 correctly uses, would connect the
client's requests as the owner: every policy would still be in the
database and not one of them would apply, because an owner is exempt
unless the table says `FORCE`, and deliberately none of them do.

Nothing would look wrong. The app would work. One client would see
every client's rows.

**So the service refuses to start on it.** Getting this wrong used to
be silent — `rls = true` was set by the variable merely being present,
and the boot line announced row-level security on that basis alone.
Now the client pool is asked who it actually connected as, before
anything is served:

```
[go-data] cannot reach Postgres: DATABASE_URL_CLIENT connects as
"postgres", which is a SUPERUSER — every row-level policy would be
inert. Refusing to start
```

It refuses the same way for a role holding `BYPASSRLS`, and for one
that owns any table in `crm` or `public` — the three ways a policy can
be present and meaningless. Fatal rather than a warning, because a
warning in a boot log is exactly what nobody reads on the day it
matters.

Restart. The line to look for is:

```
[go-data] row-level security: ON — a client's requests run as myf_client,
checked at boot: not a superuser, no BYPASSRLS, owns nothing
```

Then run `scratchpad/rls.test.cjs` against it. It asserts the three
states that matter — no identity sees nothing, the wrong person sees
nothing of the right person's, and a `SELECT` with no `WHERE` clause
still cannot escape one person's rows — plus that the practitioner's
own connection is untouched.

## 6. Her login

Nothing seeds a staff row, deliberately: a password in a migration is
a password in git, and one shared between a laptop and production is
worse. The CRM's own setup screen (`POST /api/crm/auth/setup`) creates
the first officer, and `go-data` refuses it once an account exists for
that door — so it works exactly once, on the new database, and she
chooses the password.

## 7. Something to look at, if you want it

The new database is empty of people. To put the practice in it:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/dump.sql
```

and `db/clear_practice.sql` takes it back out. `config.sql` must
already be loaded — every person names a country, and that is a
foreign key. See `README.md`.

Do not load `dump.sql` into anything a real client can reach. Nineteen
invented women with months of invented history is exactly what a
staging database is for and exactly what a production one is not.

## What must not travel

`.env` is gitignored and holds both connection strings. The client
password is a real credential: it is the one thing between a stolen
`/me/` link and one person's data, rather than everyone's.
