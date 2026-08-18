#!/usr/bin/env bash
# ============================================================
#  INSTALL — a clean Ubuntu box to a running v2, in one pass
# ------------------------------------------------------------
#  Run it in the Lightsail browser terminal. That is the point:
#  a freshly wiped instance has no ~/.ssh at all, so there is
#  nothing to add a key to and no way in from a laptop yet. The
#  browser console needs no key, and neither does this script.
#
#      git clone https://github.com/sachinkumarbari162x/mindyoufoodv2 ~/myf
#      cd ~/myf
#      bash deploy/install.sh
#
#  WHY THE DATABASE IS SET UP IN TWO PHASES. It cannot be done in
#  one, and the reason is worth stating because it looks like a
#  bug the first time you watch it.
#
#    schema.sql creates the myf_client role with NOLOGIN and no
#    password, and schema.sql is applied BY THE APP ON BOOT. So on
#    a fresh database the role does not exist until the stack has
#    started once. roles.sql, which grants it LOGIN and a password,
#    refuses outright until then -- deliberately, because a role
#    conjured out of order would not carry the policies.
#
#    So: start with the owner URL only (row-level security reports
#    OFF, and the client routes refuse to serve rather than leak),
#    then grant the role, then add DATABASE_URL_CLIENT and restart
#    into row-level security: ON. The window in between is safe by
#    construction, not by luck.
#
#  IT IS SAFE TO RUN TWICE. Every step checks before acting: swap
#  already on is left alone, Docker already installed is not
#  reinstalled, and an existing .env.prod is never overwritten
#  without asking -- regenerating SESSION_SECRET would sign
#  Khadija out of the CRM with no way for her to know why.
#
#  SECRETS ARE TYPED, NEVER PASSED AS ARGUMENTS. An argument is
#  visible in `ps` to every user on the box and lands in shell
#  history. Everything sensitive is read with `read -rs`, written
#  under umask 077, and never echoed back in full.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_FILE="$ROOT/.env.prod"
COMPOSE="deploy/docker-compose.yml"
SITE="trialcrm.mindyourfood.co.in"

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; grn=$'\033[32m'; ylw=$'\033[33m'; off=$'\033[0m'
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$bold" "$*" "$off"; }
ok()   { printf '  %s%s%s\n' "$grn" "$*" "$off"; }
warn() { printf '  %s%s%s\n' "$ylw" "$*" "$off"; }
die()  { printf '\n  %sFAILED: %s%s\n' "$red" "$*" "$off" >&2; exit 1; }
dc()   { sudo docker compose -f "$COMPOSE" "$@"; }

[ -f "$COMPOSE" ] || die "run this from the clone: cd ~/myf && bash deploy/install.sh"

# ------------------------------------------------------------
step "1 · Swap"
# 911 MB is not enough to compile a Go binary and run Node beside
# it. Without swap the build is killed partway with no useful
# message, which reads like a broken Dockerfile.
if swapon --show 2>/dev/null | grep -q '/swapfile'; then
  ok "already on ($(free -m | awk '/Swap:/{print $2}') MB)"
else
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  ok "2 GB added, and permanent across reboots"
fi

# ------------------------------------------------------------
step "2 · Docker and psql"
if command -v docker >/dev/null 2>&1; then
  ok "docker already installed ($(sudo docker --version | cut -d, -f1))"
else
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl >/dev/null
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin >/dev/null
  sudo usermod -aG docker "$USER" || true
  ok "docker installed ($(sudo docker --version | cut -d, -f1))"
fi
# Everything below uses `sudo docker` regardless: group membership
# does not apply until the next login, and this script has to work
# in the session that installed it.

if ! command -v psql >/dev/null 2>&1; then
  sudo apt-get install -y -qq postgresql-client >/dev/null 2>&1 || true
fi
command -v psql >/dev/null 2>&1 && ok "psql present" || die "psql is required: sudo apt-get install -y postgresql-client"

# ------------------------------------------------------------
step "3 · Configuration"

if [ -f "$ENV_FILE" ]; then
  warn "$ENV_FILE already exists — keeping it."
  say  "  ${dim}Regenerating SESSION_SECRET would sign Khadija out of the CRM"
  say  "  with no way for her to know why.${off}"
  printf '  Rewrite it from scratch anyway? [y/N] '
  read -r redo
  case "$redo" in [yY]*) rm -f "$ENV_FILE"; warn "removed — writing a new one" ;; *) ok "kept" ;; esac
fi

if [ ! -f "$ENV_FILE" ]; then
  say ""
  say "  Supabase → Project Settings → Database → Connection string → ${bold}Session pooler${off}"
  say "  ${dim}Port 5432, not 6543. Transaction mode breaks pgx's named prepared"
  say "  statements and the failures look like random query errors.${off}"
  say ""
  printf '  Paste DATABASE_URL (owner role): '
  read -rs DB_OWNER; echo
  [ -n "${DB_OWNER:-}" ] || die "DATABASE_URL cannot be empty"
  case "$DB_OWNER" in postgres://*|postgresql://*) ;; *) die "that does not look like a postgres:// URL" ;; esac

  # Split on the LAST '@' so a password containing '@' still parses.
  creds="${DB_OWNER%@*}"
  HOSTPART="${DB_OWNER##*@}"
  userpart="${creds#*://}"
  owner_user="${userpart%%:*}"
  case "$owner_user" in
    *.*) PROJECT_REF="${owner_user#*.}" ;;
    *)   die "username is '$owner_user' — Supabase needs <role>.<project-ref>, e.g. postgres.abcdefgh" ;;
  esac
  ok "project ref detected: $PROJECT_REF"

  say ""
  printf '  GROQ_API_KEY (optional — Enter to skip, desk runs scripted): '
  read -rs GROQ_KEY; echo
  if [ -n "${GROQ_KEY:-}" ]; then ok "accepted (${#GROQ_KEY} characters, not echoed)"
  else warn "skipped — the front desk will use its scripted answers"; fi

  umask 077
  {
    echo "# Written by deploy/install.sh. Never commit this file."
    echo "DATABASE_URL=${DB_OWNER}"
    echo ""
    echo "# Added in phase two, once myf_client exists and can log in."
    echo "DATABASE_URL_CLIENT="
    echo ""
    echo "SERVICE_TOKEN=$(openssl rand -hex 32)"
    echo "SESSION_SECRET=$(openssl rand -hex 32)"
    echo "IP_HASH_SALT=$(openssl rand -hex 32)"
    echo ""
    echo "COOKIE_SECURE=true"
    echo "PUBLIC_BASE_URL=https://${SITE}"
    echo ""
    echo "GROQ_API_KEY=${GROQ_KEY:-}"
    echo ""
    echo "# Ceilings on the paid models. Unset means 500 and 150 a day."
    echo "# AI_DESK_CALLS_PER_DAY=500"
    echo "# AI_PLAN_CALLS_PER_DAY=150"
    echo ""
    echo "# LEAVE UNSET unless you mean it -- both send real email to real people."
    echo "# APPOINTMENTS_API_URL="
    echo "# CLIENT_CODE_EMAIL=on"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  unset GROQ_KEY
  ok "wrote $ENV_FILE (0600)"
fi

# ------------------------------------------------------------
step "4 · The password for the CRM and the site"
if grep -q '^TRIAL_BASIC_HASH=..' "$ENV_FILE" 2>/dev/null; then
  ok "already set — leaving it alone"
else
  say "  ${dim}One password covers the CRM, the site and the front desk. The"
  say "  client's own app is exempt, so a client never meets it.${off}"
  while :; do
    printf '  Choose a password: '; read -rs P1; echo
    printf '  Again:             '; read -rs P2; echo
    [ -n "${P1:-}" ] || { warn "cannot be empty"; continue; }
    [ "$P1" = "${P2:-}" ] || { warn "they do not match"; continue; }
    break
  done
  bash deploy/set-basic-password.sh "$P1" >/dev/null
  unset P1 P2
  ok "set — every \$ doubled, or Compose eats the bcrypt salt"
fi

# ------------------------------------------------------------
step "5 · First boot — applies the schema"
say "  ${dim}Row-level security will report OFF here. That is expected: the role"
say "  it needs does not exist yet. The client routes refuse to serve while"
say "  that is true, rather than answering with someone else's record.${off}"
dc up -d --build

printf '  waiting for the app'
state=""
for _ in $(seq 1 48); do
  state="$(sudo docker inspect -f '{{.State.Health.Status}}' myf-v2 2>/dev/null || echo starting)"
  [ "$state" = "healthy" ] && break
  printf '.'; sleep 5
done
echo
[ "$state" = "healthy" ] || { dc logs --tail 30 v2; die "the app did not come up healthy"; }
ok "myf-v2 healthy — the schema is applied"

# ------------------------------------------------------------
step "6 · Grant the client role, then turn row-level security on"

DB_OWNER="$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
[ -n "$DB_OWNER" ] || die "DATABASE_URL missing from $ENV_FILE"

if grep -q '^DATABASE_URL_CLIENT=..' "$ENV_FILE"; then
  ok "DATABASE_URL_CLIENT already set — leaving it alone"
else
  creds="${DB_OWNER%@*}"; HOSTPART="${DB_OWNER##*@}"
  userpart="${creds#*://}"; owner_user="${userpart%%:*}"
  PROJECT_REF="${owner_user#*.}"

  # Generated, not typed: an alphanumeric password needs no URL
  # encoding, and a '@' or '/' in a hand-picked one would silently
  # corrupt the connection string.
  CLIENT_PW="$(openssl rand -hex 24)"

  # The quotes around the value are required. psql substitutes -v
  # literally, so `-v pw=secret` produces invalid SQL.
  if ! psql "$DB_OWNER" -v pw="'${CLIENT_PW}'" -f services/go-data/db/roles.sql >/tmp/roles.log 2>&1; then
    sed 's/^/    /' /tmp/roles.log >&2
    die "roles.sql failed — see above"
  fi
  ok "myf_client granted LOGIN with a fresh password"

  umask 077
  # Written with python rather than sed: the URL is full of / and &,
  # both of which sed treats as syntax.
  DB_CLIENT="postgres://myf_client.${PROJECT_REF}:${CLIENT_PW}@${HOSTPART}" \
  python3 - "$ENV_FILE" <<'PY'
import io, os, sys
p = sys.argv[1]
val = os.environ["DB_CLIENT"]
lines = io.open(p, encoding="utf-8").read().splitlines()
out, seen = [], False
for l in lines:
    if l.startswith("DATABASE_URL_CLIENT="):
        out.append("DATABASE_URL_CLIENT=" + val); seen = True
    else:
        out.append(l)
if not seen:
    out.append("DATABASE_URL_CLIENT=" + val)
io.open(p, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
PY
  chmod 600 "$ENV_FILE"
  unset CLIENT_PW DB_CLIENT
  ok "DATABASE_URL_CLIENT written"

  say "  restarting into row-level security..."
  dc up -d
  sleep 12
fi

# ------------------------------------------------------------
step "7 · What the boot log says"
dc logs v2 2>/dev/null \
  | grep -iE "row-level security|applied .* migration|configuration:|knowledge base|budgets:" \
  | tail -6 | sed 's/^/  /' || true

if dc logs --tail 200 v2 2>/dev/null | grep -q "row-level security: OFF"; then
  if ! dc logs --tail 60 v2 2>/dev/null | grep -q "row-level security: ON"; then
    echo
    die "row-level security is still OFF. A client would be served somebody else's record. Do not go live."
  fi
fi
ok "row-level security is ON"

# ------------------------------------------------------------
step "8 · Is it actually live"
check() {
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$1" || echo 000)"
  if [ "$code" = "$2" ]; then printf '  %s%-3s%s  %s\n' "$grn" "$code" "$off" "$3"
  else printf '  %s%-3s%s  %s %s(expected %s)%s\n' "$red" "$code" "$off" "$3" "$dim" "$2" "$off"; fi
}
say "  ${dim}The certificate can take up to a minute on the first request.${off}"
sleep 8
check "https://${SITE}/crm/"         401 "the CRM is locked — the one failure that matters"
check "https://${SITE}/account.html" 200 "the client app is up and password-exempt"

echo
say "  ${dim}Both reading 000 means Caddy has no certificate. Almost always port 80"
say "  closed in the Lightsail firewall — it is where the ACME challenge is"
say "  answered, however pointless 80 looks when everything redirects off it —"
say "  or DNS not pointing at this instance.${off}"

echo
ok "done"
say ""
say "  ${bold}Device testing${off} works through programme links, which need no sign-in code:"
say "    https://${SITE}/me/<token>"
say ""
say "  ${dim}The six-digit email sign-in is deliberately off. Turning it on sends"
say "  real mail to real clients and that has not been decided.${off}"
