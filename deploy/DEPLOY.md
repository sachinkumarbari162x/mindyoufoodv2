# Deploying v2 to a cleared box

One Lightsail instance, one Caddy, one container, and a Supabase
database in Mumbai. Nothing else runs here.

> The previous arrangement — sharing a box and a Caddy with the old
> backend stack — is `DEPLOY.shared-box-superseded.md`. It is kept
> because it was correct for that box, not because it was wrong.

---

## Before you start

Four things, and the first two are the ones that bite.

| | Why it matters |
|---|---|
| A record `trialcrm` → the box's IP | No DNS, no certificate, no installable app |
| **80 AND 443** open in the Lightsail firewall | 80 looks pointless because everything redirects off it. It is where the ACME challenge is answered — closed, and there is never a certificate |
| The Supabase project is in **ap-south-1 (Mumbai)** | A database in Singapore adds a round trip to every query on every page. Measured on this project: 42 ms vs 218 ms |
| `myf_client` exists in that database | Without it the client app refuses to serve — see below, and it is not a suggestion |

---

## 1 · The two database URLs

Both point at the same Supabase database and differ **only in the role**.

Take them from **Supabase → Project Settings → Database → Connection
string → Session pooler**, and read these three notes before pasting:

- **Session mode, port 5432.** Transaction mode on 6543 breaks pgx's
  named prepared statements and the failures look like random query
  errors rather than a pooling problem.
- **The username is `<role>.<project-ref>`**, not `<role>`. So
  `postgres.abcdefghijklm`, and `myf_client.abcdefghijklm`. Pasting a
  bare role name is the single commonest way to lose an afternoon here.
- Direct connections (`db.<ref>.supabase.co`) are IPv6-only and will
  not work from Lightsail. Use the pooler host.

```sh
DATABASE_URL=postgres://postgres.<ref>:<pw>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require
DATABASE_URL_CLIENT=postgres://myf_client.<ref>:<pw>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require
```

### `DATABASE_URL_CLIENT` is not optional

**If it is unset, the client app refuses to serve, and that refusal is
protecting you.**

Most queries behind `/api/client/*` carry no person in their `WHERE`
clause — they are scoped by row-level security instead:

```sql
SELECT id, ref, body, targets, issued_at
  FROM crm.plans
 WHERE status = 'issued'
 ORDER BY plan_no DESC, amendment DESC LIMIT 1
```

That returns *their* plan only because the connection's role is subject
to the policies in `schema.sql`. When `DATABASE_URL_CLIENT` is unset the
client pool falls back to the **owner**, an owner bypasses every policy,
and that query returns the most recently issued plan in the practice —
somebody else's. The same is true of the documents, receipts, labs and
goals.

So the routes check at request time and return `503 rls_required` rather
than answering. The boot log says which mode it is in; do not go live on
a line that does not read `row-level security: ON`.

Create the role once, if it is not there:

```sh
# The password is passed in, and MUST carry its own single quotes —
# psql substitutes -v literally, so `-v pw=secret` produces invalid
# SQL and `-v pw="'secret'"` is what works.
psql "$DATABASE_URL" -v pw="'a-long-random-string'" -f services/go-data/db/roles.sql
```

Use that same string in `DATABASE_URL_CLIENT`.

---

## 2 · `.env.prod`

In the project root, next to `deploy/`.

```sh
DATABASE_URL=            # see above
DATABASE_URL_CLIENT=     # see above — not optional

SERVICE_TOKEN=           # openssl rand -hex 32
SESSION_SECRET=          # openssl rand -hex 32
IP_HASH_SALT=            # openssl rand -hex 32

TRIAL_BASIC_HASH=        # step 3
COOKIE_SECURE=true       # there is TLS in front now
PUBLIC_BASE_URL=https://trialcrm.mindyourfood.co.in

GROQ_API_KEY=            # optional — without it the desk runs scripted

# LEAVE UNSET unless you mean it. Setting this makes bookings and
# newsletter sign-ups real, and both send email to actual people.
# APPOINTMENTS_API_URL=

# LEAVE UNSET for now. See "Signing in" below.
# CLIENT_CODE_EMAIL=on
```

**`SESSION_SECRET` matters more than it looks.** Unset, it is generated
at boot — so every restart, every deploy and every crash signs Khadija
out of the CRM, and she has no way to know why.

**`COOKIE_SECURE=true`** or the session cookie is sent without the
`Secure` flag over a connection that has TLS. It is one word.

---

## 3 · The password

For everything except the client app — the CRM, the site, the desk.

```sh
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'pick-a-password'
```

Put the result in `.env.prod` as `TRIAL_BASIC_HASH`, and **escape every
`$` as `$$`** — Compose interpolates `$` before Caddy sees it, and an
unescaped bcrypt hash arrives truncated with a login that silently never
matches. The admin CRM hit exactly this.

---

## 4 · Up

```sh
cd ~/khadija_dietician/khadijaDietican_v2.0.0
git pull origin feat/appointments-v1

docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f v2
```

The schema, the migrations and the configuration all apply themselves on
boot. Against Supabase that is a couple of hundred statements over the
network, so **the first boot takes a minute or two and is not a fault**.

### The four lines to look for

```
[go-data] applied N migration(s): [...]
[go-data] configuration: 187 metrics · 64 units in 4 standards · 6 client answers
[go-data] row-level security: ON — a client's requests run as myf_client
[bff] knowledge base: 11 answers loaded
```

`row-level security: ON` is the one that decides whether the client app
works at all. `11` rather than `17` answers is the front desk correctly
not loading the client's questions.

---

## 5 · Is it actually live

```sh
curl -sI https://trialcrm.mindyourfood.co.in/account.html | head -3
```

- **200** — the client app is up and unlocked, as intended.
- **401** — Caddy is serving but the exemption did not match; check the
  `@clientapp` list in `deploy/Caddyfile`.
- **TLS handshake failure / "no peer certificate"** — Caddy has the site
  and no certificate. Almost always port 80 closed in the Lightsail
  firewall, or DNS not yet pointing here.

```sh
curl -sI https://trialcrm.mindyourfood.co.in/crm/ | head -3   # expect 401
```

An unlocked CRM is the one failure on this page that matters. Check it
every time.

---

## Signing in, and the thing that is not finished

`CLIENT_CODE_EMAIL` is **off**, so the six-digit sign-in sends nothing
and nobody can use it. `CLIENT_CODE_ECHO` is refused in production, so
there is no back door either — deliberately.

**Testing on devices works today through programme links**, which need
no code:

```
https://trialcrm.mindyourfood.co.in/me/<token>
```

A token opens the plan, the day, the calendar and the questions, and
never the receipts, the labs, the documents or the contact details —
because it lives in a URL and gets forwarded. The six-digit code is what
opens the rest.

Turning the email on is a one-word change and a decision about sending
real mail to real people. It has not been made.

---

## Rolling back

```sh
git log --oneline -10
git checkout <sha>
docker compose -f deploy/docker-compose.yml up -d --build
```

Migrations do not roll back. They are additive — a column, a widened
CHECK, a renamed metric value — so an older image runs against a newer
database without complaint. The one exception is `0007`, which renamed
`weight_kg` to `weight`: an image from before it reads no weights until
you go forward again.
