#!/usr/bin/env bash
# Set TRIAL_BASIC_HASH in .env.prod from a plaintext password.
#
# Compose interpolates values read from env_file, so a bcrypt hash --
# which is full of $ -- must have EVERY $ doubled or Compose eats the
# salt as an undefined variable and the login silently never matches.
# Proven on this box: $2a$14$ZDOW... arrived as $2a$14.WLM...
#
# The doubling uses [$] rather than \$ on purpose: in a sed regex a
# bare $ is the end-of-line anchor, so s/$/$$/ APPENDS instead of
# substituting. That is the exact bug this script exists to prevent.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 'plaintext-password'" >&2; exit 1; }
# Resolve the project root from this script's own location. The
# clone path is not ours to assume -- it was hardcoded here and
# broke the moment the deployment repo was cloned anywhere else.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RAW=$(sudo docker run --rm caddy:2-alpine caddy hash-password --plaintext "$1" 2>/dev/null)
case "$RAW" in
  '$2a$'*) ;;
  *) echo "hash did not look like bcrypt: $RAW" >&2; exit 1 ;;
esac
ESC=$(printf '%s' "$RAW" | sed 's/[$]/$$/g')

python3 - "$ESC" <<'PY'
import sys, io
esc = sys.argv[1]
p = ".env.prod"
lines = io.open(p, encoding="utf-8").read().splitlines()
out, seen = [], False
for l in lines:
    if l.startswith("TRIAL_BASIC_HASH="):
        out.append("TRIAL_BASIC_HASH=" + esc); seen = True
    else:
        out.append(l)
if not seen:
    out.append("TRIAL_BASIC_HASH=" + esc)
io.open(p, "w", encoding="utf-8", newline="\n").write("\n".join(out) + "\n")
PY
chmod 600 .env.prod
echo "  written, every \$ doubled"
