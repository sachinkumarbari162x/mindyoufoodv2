# Mind Your Food — v2 deployment

The v2 stack, and only the v2 stack: the marketing site, the front
desk, the CRM, the consulting room and the client's account panel.

This repository is **generated**. It is assembled from the working
tree by `deploy/bundle.sh` and pushed here, so nothing in it should
be edited by hand — an edit made here is lost the next time the
bundle is rebuilt. Change the source, rebuild, push.

## What runs

Four processes in one container. Only the first is reachable from
outside; `run.js` binds the rest to loopback.

| | |
|---|---|
| `5501` | `server.js` — static site and `/api` proxy |
| `5502` | `services/node-bff` — rules, sessions, booking |
| `5503` | `services/py-ai` — the model |
| `5504` | `services/go-data` — Postgres |

Caddy sits in front, terminates TLS, and holds everything except the
client's own app behind a password.

## Deploying

`deploy/DEPLOY.md` is the runbook. In short:

```sh
git clone https://github.com/sachinkumarbari162x/mindyoufoodv2 ~/myf
cd ~/myf
# write .env.prod — see DEPLOY.md; it is git-ignored on purpose
deploy/set-basic-password.sh 'the password'
sudo docker compose -f deploy/docker-compose.yml up -d --build
```

## What is deliberately not here

Secrets are not in this repository and must never be. `.env.prod`
lives on the server at `0600`, is listed in `.gitignore`, and is
excluded from the Docker build context by `.dockerignore` so it
cannot end up in an image layer either.

Also absent, and not by accident:

- `var/` — client progress photographs, clinical documents and
  database dumps. This is the practice's most sensitive data and it
  belongs on the server's disk and nowhere else.
- `docs/`, `trial/` — working notes and a scratch Python environment.
- Windows `.exe` builds — around 187 MB of them, all the wrong
  architecture for the server. The Go binary is compiled inside the
  image from the source that *is* here.

**While this repository is public, treat every file in it as
readable by anyone.** Making it private later does not retract what
has already been fetched or cached, so the answer to "should this be
committed" stays no even after the switch.
