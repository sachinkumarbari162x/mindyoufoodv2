package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// Handlers get a shorter deadline than the HTTP write timeout, so a
// slow query fails as a clean 503 rather than the connection being
// cut from under it.
const handlerBudget = 8 * time.Second

func routes(st *Store) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", health(st))
	mux.HandleFunc("POST /bmi", saveBMI(st))
	mux.HandleFunc("POST /handoff/claim", claimHandoff(st))
	mux.HandleFunc("POST /appointments", createAppointment(st))
	mux.HandleFunc("GET /appointments/recent", recentAppointments(st))

	// Read-only browsing of what is actually stored. See dbview.go —
	// this is every piece of PII in the system in one place, so it
	// must sit behind a login wherever it is exposed.
	mux.HandleFunc("GET /db/tables", dbTables(st))
	mux.HandleFunc("GET /db/rows", dbRows(st))

	// ---- the CRM schema ----
	mux.HandleFunc("GET /crm/overview", crmOverview(st))
	mux.HandleFunc("GET /crm/consultations", crmConsultationsHandler(st))
	mux.HandleFunc("GET /crm/people", crmPeopleHandler(st))
	mux.HandleFunc("GET /crm/countries", crmCountries(st))
	mux.HandleFunc("GET /crm/slots", crmSlots(st))
	mux.HandleFunc("GET /crm/hours", crmHours(st))
	/* The month, as she works it — her week, the days that break it,
	   and who is in the diary. Range-aware, unlike the slot engine. */
	mux.HandleFunc("GET /crm/calendar", crmCalendar(st))
	// ---- what happened after the booking ----
	mux.HandleFunc("POST /crm/consultations/{id}/outcome", crmOutcomeAdd(st))
	mux.HandleFunc("GET /crm/outcomes", crmOutcomeList(st))
	mux.HandleFunc("GET /crm/outcomes/stats", crmOutcomeStats(st))
	mux.HandleFunc("DELETE /crm/outcomes/{id}", crmOutcomeUndo(st))
	mux.HandleFunc("GET /crm/unrecorded", crmUnrecorded(st))
	mux.HandleFunc("GET /crm/consultations/{id}", crmConsultationOne(st))

	/* ---- the opaque link ----
	   Minting is hers. Resolving is reached from a WhatsApp message
	   by somebody who has proved nothing — it is public at the BFF,
	   and answers with the least it can. */
	mux.HandleFunc("POST /crm/consultations/{id}/link", crmLinkMint(st))
	mux.HandleFunc("GET /link/{token}", linkResolve(st))

	// ---- what the system sent ----
	mux.HandleFunc("POST /crm/messages", crmMessageQueue(st))
	mux.HandleFunc("PATCH /crm/messages/{id}", crmMessageResult(st))
	mux.HandleFunc("GET /crm/messages", crmMessageList(st))
	mux.HandleFunc("GET /crm/messages/{id}", crmMessageOne(st))
	mux.HandleFunc("GET /crm/people/exists", crmPersonExists(st))

	/* ---- the consultation room, remembered ----
	   The sockets stay in the BFF's memory; the facts live here. */
	mux.HandleFunc("POST /crm/rooms/join", crmRoomJoin(st))
	mux.HandleFunc("POST /crm/rooms/state", crmRoomState(st))
	mux.HandleFunc("POST /crm/rooms/leave", crmRoomLeave(st))
	mux.HandleFunc("GET /crm/rooms", crmRoomList(st))
	mux.HandleFunc("POST /crm/ratings", crmRatingAdd(st))

	/* ---- the assessment record ----
	   Versioned and amend-forward. There is no DELETE here at all,
	   and no UPDATE that touches a finalised row. */
	mux.HandleFunc("GET /crm/assessments", crmAssessmentList(st))
	mux.HandleFunc("GET /crm/assessments/{id}", crmAssessmentOne(st))
	mux.HandleFunc("POST /crm/assessments", crmAssessmentOpen(st))
	mux.HandleFunc("PATCH /crm/assessments/{id}", crmAssessmentSave(st))
	mux.HandleFunc("POST /crm/assessments/{id}/final", crmAssessmentFinal(st))
	mux.HandleFunc("POST /crm/assessments/{id}/amend", crmAssessmentAmend(st))

	/* ---- the care plan ----
	   The same rules, for the document that leaves the building.
	   No DELETE here either, and the only UPDATE refuses a plan
	   that has been issued — see the WHERE clause in crmPlanSave. */
	mux.HandleFunc("GET /crm/plans", crmPlanList(st))
	mux.HandleFunc("GET /crm/plan", crmPlanOne(st))
	mux.HandleFunc("POST /crm/plans", crmPlanOpen(st))
	mux.HandleFunc("PATCH /crm/plans/{id}", crmPlanSave(st))
	mux.HandleFunc("POST /crm/plans/{id}/read", crmPlanReadClaim(st))
	/* Its own budget, claimed before the call rather than after —
	   see crmPlanDraftClaim for why the order differs. */
	mux.HandleFunc("POST /crm/plans/{id}/draft", crmPlanDraftClaim(st))
	mux.HandleFunc("POST /crm/plans/{id}/issue", crmPlanIssue(st))
	mux.HandleFunc("POST /crm/plans/{id}/amend", crmPlanAmend(st))

	/* The client's way into their plan. The mint is behind her
	   session like everything else under /crm/; the resolve is
	   PUBLIC and is the only unauthenticated route in this service
	   that returns clinical text — see plan_links.go. */
	mux.HandleFunc("POST /crm/plans/{id}/link", crmPlanLinkMint(st))
	mux.HandleFunc("GET /plan-link/{token}", planLinkResolve(st))

	/* ---- what a model thinks the plan says ----
	   Proposals, and her verdict on them. Nothing downstream reads
	   these yet; they exist to measure how often the assistant is
	   right before anything is allowed to depend on it. */
	mux.HandleFunc("GET /crm/plan-items", crmPlanItemList(st))
	mux.HandleFunc("POST /crm/plan-items", crmPlanItemsRead(st))
	mux.HandleFunc("PATCH /crm/plan-items/{id}", crmPlanItemVerdict(st))
	mux.HandleFunc("DELETE /crm/plan-items/{id}", crmPlanItemDrop(st))
	// The whole panel at once. Same rule: only what she has not ruled on.
	mux.HandleFunc("DELETE /crm/plan-items", crmPlanItemsClear(st))
	mux.HandleFunc("GET /crm/plan-items/accuracy", crmPlanItemAccuracy(st))

	/* ---- the client working through it ----
	   Her side mints and revokes; the client's side is PUBLIC and is
	   the only place in this service where an unauthenticated caller
	   may WRITE. Every one of those writes is bounded to their own
	   programme and their own plan — see programmes.go. */
	mux.HandleFunc("POST /crm/plans/{id}/programme", crmProgrammeStart(st))
	mux.HandleFunc("POST /crm/programmes/{id}/revoke", crmProgrammeRevoke(st))
	mux.HandleFunc("GET /crm/programmes", crmProgrammeList(st))
	mux.HandleFunc("GET /crm/adherence", crmAdherence(st))

	/* Her read of the same days the client is filling in. Behind her
	   session, by programme id — she never holds the token. See
	   programme_monitor.go. */
	mux.HandleFunc("GET /crm/programme/days", crmProgrammeDays(st))
	mux.HandleFunc("GET /crm/programme/weights", crmProgrammeWeights(st))
	mux.HandleFunc("GET /crm/programme/notes", crmProgrammeNotes(st))
	// Her answer. The only route that writes a 'practitioner' line.
	mux.HandleFunc("POST /crm/programme/notes", crmProgrammeReply(st))

	/* Something they wanted to say that no row on the plan has a box
	   for. The second public write path in this service — see
	   programme_notes.go for its bounds. */
	/* A client on a programme asking to be seen again. The third
	   public write path — see review_requests.go for its bounds. */
	mux.HandleFunc("POST /programme/{token}/review", programmeReviewAsk(st))
	mux.HandleFunc("GET /programme/{token}/review", programmeReviewState(st))
	mux.HandleFunc("POST /crm/consultations/{id}/schedule", crmConsultationSchedule(st))

	mux.HandleFunc("POST /programme/{token}/note", programmeNoteAdd(st))
	mux.HandleFunc("GET /programme/{token}/notes", programmeNotesList(st))

	mux.HandleFunc("GET /programme/{token}", programmeResolve(st))
	mux.HandleFunc("GET /programme/{token}/days", programmeDays(st))
	mux.HandleFunc("POST /programme/{token}/checkin", programmeCheckin(st))
	mux.HandleFunc("POST /programme/{token}/weight", programmeWeight(st))
	/* Reading back what they typed. Only their own self-reported
	   weights — see programme_progress.go for what it withholds. */
	mux.HandleFunc("GET /programme/{token}/weights", programmeWeights(st))

	/* ---- photographs ----
	   Go records that one exists and where it went; the bytes never
	   pass through this service. See checkin_media.go. */
	mux.HandleFunc("POST /programme/{token}/media", programmeMediaAdd(st))
	mux.HandleFunc("GET /programme/{token}/media", programmeMediaList(st))
	mux.HandleFunc("GET /programme/{token}/media/one", programmeMediaOne(st))
	mux.HandleFunc("GET /crm/media", crmMediaList(st))
	mux.HandleFunc("GET /crm/media/one", crmMediaOne(st))

	/* ---- the client's account ----
	   A PERSON rather than a programme: identity that outlives any
	   one plan. Everything here is behind the service token like
	   the rest of this service — the BFF holds the client's cookie
	   and this service never sees it. See client_auth.go for how
	   somebody signs in, client_account.go for what they can then
	   read, and neither of them for the person id, which does not
	   leave this process. */
	mux.HandleFunc("POST /client/codes", clientCodeStore(st))
	mux.HandleFunc("GET /client/codes", clientCodeGet(st))
	mux.HandleFunc("POST /client/codes/{id}/miss", clientCodeMiss(st))
	mux.HandleFunc("POST /client/codes/{id}/use", clientCodeUse(st))
	mux.HandleFunc("GET /client/session", clientSessionResolve(st))
	mux.HandleFunc("POST /client/session/from-token", clientSessionFromToken(st))
	mux.HandleFunc("POST /client/session/revoke", clientSessionRevoke(st))
	mux.HandleFunc("GET /client/me", clientMe(st))
	mux.HandleFunc("POST /client/checkin", clientCheckin(st))
	mux.HandleFunc("POST /client/review", clientReviewAsk(st))
	mux.HandleFunc("POST /client/weight", clientWeight(st))
	mux.HandleFunc("POST /client/note", clientNote(st))
	mux.HandleFunc("POST /client/media", clientMedia(st))

	/* ---- the metric registry, units and settings ----
	   One catalogue of what this practice measures, one table of
	   what a unit is, and the handful of choices that decide how
	   every number is shown. Nothing here converts anything — see
	   metrics.go for why the arithmetic lives at the edge. */
	mux.HandleFunc("GET /crm/metrics", crmMetrics(st))
	mux.HandleFunc("GET /crm/units", crmUnits(st))
	mux.HandleFunc("GET /crm/settings", crmSettings(st))
	mux.HandleFunc("PATCH /crm/settings/{key}", crmSettingSave(st))

	mux.HandleFunc("GET /crm/hours/clash", crmHoursClash(st))
	mux.HandleFunc("POST /crm/hours/rules", crmAddRules(st))
	mux.HandleFunc("DELETE /crm/hours/rules/{id}", crmDropRule(st))
	mux.HandleFunc("POST /crm/hours/exceptions", crmAddException(st))
	mux.HandleFunc("DELETE /crm/hours/exceptions/{id}", crmDropException(st))

	// ---- the knowledge and intelligence base ----
	mux.HandleFunc("POST /crm/payments", crmPaymentAdd(st))
	/* What came in, what is outstanding, what went back —
	   see payments_list.go. */
	mux.HandleFunc("GET /crm/payments", crmPaymentList(st))

	/* Run the hold sweep now rather than waiting for the ticker.
	   Loopback only, like everything else here. It exists because a
	   ten-minute timer is not something a test can wait for, and
	   because "give the abandoned hours back now" is a reasonable
	   thing to want on the day somebody notices a blocked morning.
	   Safe to call at any time: it only touches holds that have
	   already expired. */
	mux.HandleFunc("POST /admin/release-holds", adminReleaseHolds(st))

	// ---- what the client is handed after paying ----
	mux.HandleFunc("POST /crm/invoices", crmInvoiceIssue(st))
	mux.HandleFunc("GET /crm/invoices/{id}", crmInvoiceGet(st))

	/* ---- the checkout ----
	   Minting is behind her service token; resolving and confirming
	   are reached by a visitor holding an opaque token and nothing
	   else. See checkout.go for what the page is allowed to know. */
	mux.HandleFunc("POST /crm/consultations/{id}/checkout", crmCheckoutMint(st))
	mux.HandleFunc("GET /checkout/{token}", checkoutResolve(st))
	mux.HandleFunc("POST /checkout/{token}/paid", checkoutPaid(st))
	/* Picking up a checkout whose hold ran out, if the hour is
	   still free. See checkout.go. */
	mux.HandleFunc("POST /checkout/{token}/resume", checkoutResume(st))

	// ---- measurement and the switches (item 13) ----
	mux.HandleFunc("POST /crm/bot-turns", crmBotTurnAdd(st))
	mux.HandleFunc("GET /crm/bot-turns", crmBotTurnList(st))
	mux.HandleFunc("GET /crm/bot-turns/stats", crmBotStats(st))
	mux.HandleFunc("GET /crm/bot-switches", crmBotSwitchList(st))
	mux.HandleFunc("POST /crm/bot-switches", crmBotSwitchSet(st))

	// ---- the door, and the record (items 5 & 6) ----
	mux.HandleFunc("GET /crm/staff", crmStaffGet(st))
	mux.HandleFunc("POST /crm/staff", crmStaffCreate(st))
	mux.HandleFunc("PATCH /crm/staff/{id}", crmStaffPatch(st))
	mux.HandleFunc("POST /crm/audit", crmAuditAdd(st))
	mux.HandleFunc("GET /crm/audit", crmAuditList(st))

	mux.HandleFunc("GET /crm/knowledge", crmKnowledge(st))
	mux.HandleFunc("POST /crm/knowledge", crmAddTopic(st))
	mux.HandleFunc("PATCH /crm/knowledge/{intent}", crmSetAnswer(st))
	mux.HandleFunc("POST /crm/phrasings", crmAddPhrasing(st))
	mux.HandleFunc("DELETE /crm/phrasings/{id}", crmDropPhrasing(st))
	mux.HandleFunc("POST /crm/unrecognised", crmMissed(st))
	mux.HandleFunc("POST /crm/unrecognised/{id}/done", crmMissedDone(st))
	mux.HandleFunc("POST /crm/people", crmRegisterPerson(st))
	mux.HandleFunc("POST /crm/consultations", crmCreateConsultation(st))
	mux.HandleFunc("POST /crm/consultations/{id}/status", crmSetStatus(st))

	// Token first, logging outside it, so a rejected request is still
	// recorded — an unauthorised call is exactly the one worth seeing.
	return logging(requireToken(mux))
}

// ---- BMI ------------------------------------------------------------

type bmiRequest struct {
	HeightCm float64 `json:"heightCm"`
	WeightKg float64 `json:"weightKg"`
	AgeYears *int    `json:"ageYears"`
	Sex      *string `json:"sex"`
	Goal     *string `json:"goal"`
	Units    string  `json:"units"`
	// Which cut-off table to classify against. Asian-Pacific thresholds
	// are lower; the practice is in India, so this is a real choice and
	// not a formality — but it is the CALLER's choice, recorded, not
	// something this service decides on its own.
	Basis string `json:"categoryBasis"`
}

func saveBMI(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in bmiRequest
		if err := decode(r, &in); err != nil {
			bad(w, http.StatusBadRequest, "malformed_json", err.Error())
			return
		}

		// Bounds mirror the CHECK constraints. Catching them here means
		// the visitor gets a sentence rather than a constraint violation.
		if in.HeightCm < 60 || in.HeightCm > 260 {
			bad(w, http.StatusBadRequest, "height_range", "Height should be between 60cm and 260cm.")
			return
		}
		if in.WeightKg < 20 || in.WeightKg > 400 {
			bad(w, http.StatusBadRequest, "weight_range", "Weight should be between 20kg and 400kg.")
			return
		}

		bmi := bmiValue(in.HeightCm, in.WeightKg)
		if bmi < 5 || bmi > 100 {
			bad(w, http.StatusBadRequest, "bmi_range", "Those numbers give an impossible BMI — could you check them?")
			return
		}

		basis := in.Basis
		if basis != "asian" {
			basis = "who"
		}
		units := in.Units
		if units != "imperial" {
			units = "metric"
		}

		ctx, cancel := context.WithTimeout(r.Context(), handlerBudget)
		defer cancel()

		token, snap, err := st.SaveSnapshot(ctx, Snapshot{
			HeightCm:      round1(in.HeightCm),
			WeightKg:      round1(in.WeightKg),
			BMI:           bmi,
			Category:      classify(bmi, basis),
			CategoryBasis: basis,
			AgeYears:      in.AgeYears,
			Sex:           normaliseSex(in.Sex),
			Goal:          in.Goal,
			Units:         units,
		}, hashIP(r), truncate(r.UserAgent(), 400))
		if err != nil {
			log.Printf("[go-data] save bmi: %v", err)
			bad(w, http.StatusServiceUnavailable, "store_failed", "Could not save that just now.")
			return
		}

		writeJSON(w, http.StatusCreated, map[string]any{
			"ok":           true,
			"snapshot":     snap,
			"handoffToken": token,
			"expiresInSec": int(st.cfg.HandoffTTL.Seconds()),
		})
	}
}

// bmiValue is kg / m². Rounded to one decimal because a BMI carrying
// four decimals implies a precision the input never had — people
// round their own weight to the nearest kilo.
func bmiValue(heightCm, weightKg float64) float64 {
	m := heightCm / 100
	return round1(weightKg / (m * m))
}

// classify returns the band. Two tables, because the WHO's default
// cut-offs understate risk in South Asian populations and the practice
// is in India — see WHO Expert Consultation, Lancet 2004.
func classify(bmi float64, basis string) string {
	if basis == "asian" {
		switch {
		case bmi < 18.5:
			return "underweight"
		case bmi < 23:
			return "healthy"
		case bmi < 25:
			return "at risk"
		case bmi < 30:
			return "obese I"
		default:
			return "obese II"
		}
	}
	switch {
	case bmi < 18.5:
		return "underweight"
	case bmi < 25:
		return "healthy"
	case bmi < 30:
		return "overweight"
	case bmi < 35:
		return "obese I"
	case bmi < 40:
		return "obese II"
	default:
		return "obese III"
	}
}

// ---- handoff --------------------------------------------------------

func claimHandoff(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Token string `json:"token"`
		}
		if err := decode(r, &in); err != nil {
			bad(w, http.StatusBadRequest, "malformed_json", err.Error())
			return
		}
		if in.Token == "" {
			bad(w, http.StatusBadRequest, "missing_token", "No token supplied.")
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), handlerBudget)
		defer cancel()

		snap, err := st.ClaimHandoff(ctx, in.Token)
		if errors.Is(err, ErrNotFound) {
			// Unknown, already used and expired all answer the same, so
			// this cannot be used to learn which tokens once existed.
			bad(w, http.StatusNotFound, "not_found", "That link has expired or has already been used.")
			return
		}
		if err != nil {
			log.Printf("[go-data] claim: %v", err)
			bad(w, http.StatusServiceUnavailable, "store_failed", "Could not read that just now.")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "snapshot": snap})
	}
}

// ---- appointments ---------------------------------------------------

func createAppointment(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var in Appointment
		if err := decode(r, &in); err != nil {
			bad(w, http.StatusBadRequest, "malformed_json", err.Error())
			return
		}
		for field, val := range map[string]string{
			"reference": in.Reference, "name": in.Name,
			"email": in.Email, "focusArea": in.FocusArea,
		} {
			if strings.TrimSpace(val) == "" {
				bad(w, http.StatusBadRequest, "missing_field", fmt.Sprintf("%s is required.", field))
				return
			}
		}

		ctx, cancel := context.WithTimeout(r.Context(), handlerBudget)
		defer cancel()

		out, err := st.SaveAppointment(ctx, in)
		if err != nil {
			log.Printf("[go-data] save appointment: %v", err)
			bad(w, http.StatusServiceUnavailable, "store_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "appointment": out})
	}
}

func recentAppointments(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		ctx, cancel := context.WithTimeout(r.Context(), handlerBudget)
		defer cancel()

		rows, err := st.RecentAppointments(ctx, limit)
		if err != nil {
			log.Printf("[go-data] recent: %v", err)
			bad(w, http.StatusServiceUnavailable, "store_failed", "Could not read the list.")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": len(rows), "appointments": rows})
	}
}

// ---- health ---------------------------------------------------------

func health(st *Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()

		// A real round trip, not just "the pool object exists" — the
		// interesting failure is Postgres gone while the pool still
		// holds handles it believes are live.
		start := time.Now()
		err := st.Ping(ctx)
		status := http.StatusOK
		if err != nil {
			status = http.StatusServiceUnavailable
		}
		writeJSON(w, status, map[string]any{
			"ok":       err == nil,
			"service":  "go-data",
			"pingMs":   time.Since(start).Milliseconds(),
			"pool":     st.Stats(),
			"database": st.cfg.DBName(),
		})
	}
}

// ---- plumbing -------------------------------------------------------

func decode(r *http.Request, v any) error {
	// 64 KB is far more than any of these payloads; the cap stops a
	// hostile body exhausting memory before it is ever parsed.
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return err
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func bad(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": code, "message": msg})
}

func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		// Path and status only. Bodies here carry body measurements and
		// contact details; they do not belong in a log.
		log.Printf("[go-data] %s %s %d %dms",
			r.Method, r.URL.Path, rec.status, time.Since(start).Milliseconds())
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(c int) {
	s.status = c
	s.ResponseWriter.WriteHeader(c)
}

func hashIP(r *http.Request) string {
	ip := r.RemoteAddr
	if h, _, err := net.SplitHostPort(ip); err == nil {
		ip = h
	}
	salt := os.Getenv("IP_HASH_SALT")
	if salt == "" {
		salt = "dev-only-salt-change-me"
	}
	sum := sha256.Sum256([]byte(ip + salt))
	return hex.EncodeToString(sum[:])[:24]
}

func normaliseSex(s *string) *string {
	if s == nil {
		return nil
	}
	v := strings.ToLower(strings.TrimSpace(*s))
	switch v {
	case "female", "male", "unspecified":
		return &v
	case "f", "woman":
		out := "female"
		return &out
	case "m", "man":
		out := "male"
		return &out
	}
	out := "unspecified"
	return &out
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func round1(f float64) float64 { return math.Round(f*10) / 10 }
