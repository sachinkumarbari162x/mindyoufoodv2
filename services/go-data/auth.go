// SERVICE TOKEN — who is allowed to talk to the data service
//
// go-data holds every name, email, date of birth and health note in
// the system. It binds to loopback, which stops the internet reaching
// it but does NOT stop anything else running on the same box — a
// second process, a stray container, a compromised dependency in some
// unrelated service. The token is the difference between "not exposed
// to the internet" and "actually protected".
//
// Set SERVICE_TOKEN in both services and every request must carry:
//
//	Authorization: Bearer <token>
//
// Unset, the service logs a warning at boot and runs open, because
// `node run.js` with no .env has to work — that rule is what keeps a
// fresh clone runnable. Production must set it; see .env.example.
package main

import (
	"crypto/subtle"
	"log"
	"net/http"
	"os"
	"strings"
)

// /health is always open. A liveness probe that needs a credential is
// a liveness probe that reports "down" the day the credential is
// wrong, which is exactly when you need it to be telling the truth.
var openPaths = map[string]bool{"/health": true}

type guard struct {
	token string
	next  http.Handler
}

func requireToken(next http.Handler) http.Handler {
	token := strings.TrimSpace(os.Getenv("SERVICE_TOKEN"))

	if token == "" {
		log.Printf("[go-data] \033[33m!\033[0m SERVICE_TOKEN is not set — running open on loopback. " +
			"Set it in production.")
	} else {
		log.Printf("[go-data] service token required on every route except /health")
	}

	return &guard{token: token, next: next}
}

func (g *guard) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if g.token == "" || openPaths[r.URL.Path] {
		g.next.ServeHTTP(w, r)
		return
	}

	presented := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))

	// Constant time: a plain == leaks the length of the matching
	// prefix through timing, which is enough to recover a token one
	// byte at a time given enough attempts.
	if subtle.ConstantTimeCompare([]byte(presented), []byte(g.token)) != 1 {
		bad(w, http.StatusUnauthorized, "unauthorized", "missing or wrong service token")
		return
	}

	g.next.ServeHTTP(w, r)
}
