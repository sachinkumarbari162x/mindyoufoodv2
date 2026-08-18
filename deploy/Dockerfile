# ============================================================
#  The v2 stack in one image
#
#  Four processes, three languages, and — unusually — no package
#  manager step at all: node-bff, py-ai and go-data each use only
#  their standard library. There is no npm install and no pip
#  install here because there is nothing to install, which is why
#  this image is small and builds in seconds.
#
#      5501  server.js          static site + /api proxy   (exposed)
#      5502  services/node-bff  rules, sessions, booking   (loopback)
#      5503  services/py-ai     the model                  (loopback)
#      5504  services/go-data   Postgres                   (loopback)
#
#  Only 5501 is reachable; run.js binds the other three to 127.0.0.1
#  inside the container.
# ============================================================

# ---- 1 · build the Go service ------------------------------------
FROM golang:1.26-alpine AS go-build
WORKDIR /src
COPY services/go-data/go.mod services/go-data/go.sum ./
RUN go mod download
COPY services/go-data/ ./
# The name run.js looks for on Linux. Static, so the runtime image
# needs no Go toolchain and no libc surprises on alpine.
RUN CGO_ENABLED=0 go build -o godata .

# ---- 2 · the runtime ---------------------------------------------
FROM node:22-alpine

# The AI service is stdlib-only Python, so the interpreter is the
# whole dependency.
RUN apk add --no-cache python3 tzdata

WORKDIR /app

COPY server.js run.js ./
COPY public/ ./public/
COPY crm/ ./crm/
COPY services/ ./services/
COPY scripts/ ./scripts/

# Replace whatever came from the build context with the binary built
# above — a stale godata.exe from a laptop is the wrong architecture,
# and run.js prefers a prebuilt binary over `go run`.
COPY --from=go-build /src/godata ./services/go-data/godata
RUN rm -f services/go-data/*.exe services/go-data/*.exe~ || true

# The practice runs on IST and the hours rules are written in it.
ENV TZ=Asia/Kolkata
ENV NODE_ENV=production

# The one writable place. A named volume is mounted here, and Docker
# seeds a fresh volume from the image -- including ownership. Create
# it as node now, or the volume comes up root-owned, the container
# runs as node, and the first upload fails with EACCES on a box where
# nobody is watching the logs.
RUN mkdir -p /app/var/uploads && chown -R node:node /app/var

EXPOSE 5501

# Never run as root in a container that faces a reverse proxy.
USER node

CMD ["node", "run.js"]
