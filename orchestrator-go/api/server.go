// Package api is the sidecar's HTTP API.
//
//	GET  /healthz                 liveness
//	GET  /v1/agents               agents the planner can use
//	POST /v1/plan                 {"task"} -> a validated plan, not run
//	POST /v1/runs                 {"task"} or {"plan"}, optional max_tokens / max_parallel / conversation_id -> 202 + run
//	GET  /v1/runs                 every run in memory, newest first
//	GET  /v1/runs/{id}            one run's status and step results (?wait=N long-polls up to N seconds)
//	GET  /v1/runs/{id}/result     the merged final answer: 200 when finished, 202 while running (?wait=N)
//	POST /v1/runs/{id}/cancel     cancel a run
package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"boop-agent/orchestrator/engine"
	"boop-agent/orchestrator/plan"
)

const maxBodyBytes = 1 << 20

// Request limits.
const (
	// MaxTaskChars caps a submitted task (matches Boop's bridge).
	MaxTaskChars = 20_000
	// MaxRunTokens caps a per-run max_tokens.
	MaxRunTokens = 2_000_000
	// MaxWait caps ?wait= long-polls.
	MaxWait = 60 * time.Second
	// maxConversationID caps conversation_id.
	maxConversationID = 200
)

var runIDRe = regexp.MustCompile(`^run_[0-9a-f]{16}$`)

// Server serves the API for a Manager.
type Server struct {
	Manager *engine.Manager
	// Token, if set, must be sent as "Authorization: Bearer <token>" on every
	// request except /healthz.
	Token string
}

// Handler returns the API's http.Handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "planner": s.Manager.HasPlanner()})
	})
	mux.HandleFunc("GET /v1/agents", s.auth(s.agents))
	mux.HandleFunc("POST /v1/plan", s.auth(s.plan))
	mux.HandleFunc("POST /v1/runs", s.auth(s.submit))
	mux.HandleFunc("GET /v1/runs", s.auth(s.list))
	mux.HandleFunc("GET /v1/runs/{id}", s.auth(s.get))
	mux.HandleFunc("GET /v1/runs/{id}/result", s.auth(s.result))
	mux.HandleFunc("POST /v1/runs/{id}/cancel", s.auth(s.cancel))
	return mux
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.Token != "" {
			got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if subtle.ConstantTimeCompare([]byte(got), []byte(s.Token)) != 1 {
				writeError(w, http.StatusUnauthorized, "missing or wrong bearer token")
				return
			}
		}
		next(w, r)
	}
}

func (s *Server) agents(w http.ResponseWriter, r *http.Request) {
	rules := s.Manager.Rules(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"agents": rules.Agents, "integrations": rules.Integrations})
}

type planRequest struct {
	Task string `json:"task"`
}

func (s *Server) plan(w http.ResponseWriter, r *http.Request) {
	var req planRequest
	if !decode(w, r, &req) {
		return
	}
	if strings.TrimSpace(req.Task) == "" {
		writeError(w, http.StatusBadRequest, "task is required")
		return
	}
	if len(req.Task) > MaxTaskChars {
		writeError(w, http.StatusBadRequest, fmt.Sprintf("task is longer than %d characters", MaxTaskChars))
		return
	}
	res, err := s.Manager.Plan(r.Context(), req.Task)
	if err != nil {
		writePlanError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

type runRequest struct {
	Task        string     `json:"task,omitempty"`
	Plan        *plan.Plan `json:"plan,omitempty"`
	MaxTokens   int        `json:"max_tokens,omitempty"`
	MaxParallel int        `json:"max_parallel,omitempty"`
	// ConversationID is the Boop conversation the run belongs to; Boop
	// sub-agents spawned by the run are tied to it.
	ConversationID string `json:"conversation_id,omitempty"`
}

// validate checks a run request. It returns the trimmed task, or a message for a 400.
func (req runRequest) validate() (string, string) {
	task := strings.TrimSpace(req.Task)
	switch {
	case (task == "") == (req.Plan == nil):
		return "", `send exactly one of "task" (text to plan) or "plan" (a ready-made plan)`
	case len(task) > MaxTaskChars:
		return "", fmt.Sprintf("task is longer than %d characters", MaxTaskChars)
	case req.MaxTokens < 0 || req.MaxTokens > MaxRunTokens:
		return "", fmt.Sprintf("max_tokens must be between 1 and %d (or left out for the default)", MaxRunTokens)
	case req.MaxParallel < 0 || req.MaxParallel > engine.MaxParallelLimit:
		return "", fmt.Sprintf("max_parallel must be between 1 and %d (or left out for the default)", engine.MaxParallelLimit)
	case len(req.ConversationID) > maxConversationID:
		return "", fmt.Sprintf("conversation_id is longer than %d characters", maxConversationID)
	case req.Plan != nil && len(req.Plan.Tasks) == 0:
		return "", "plan has no tasks"
	}
	return task, ""
}

func (s *Server) submit(w http.ResponseWriter, r *http.Request) {
	var req runRequest
	if !decode(w, r, &req) {
		return
	}
	task, msg := req.validate()
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	o := engine.Overrides{MaxTokens: req.MaxTokens, MaxParallel: req.MaxParallel, ConversationID: strings.TrimSpace(req.ConversationID)}
	var st engine.RunStatus
	var err error
	if req.Plan != nil {
		st, err = s.Manager.SubmitPlan(r.Context(), *req.Plan, o)
	} else {
		st, err = s.Manager.SubmitTask(task, o)
	}
	if err != nil {
		writePlanError(w, err)
		return
	}
	w.Header().Set("Location", "/v1/runs/"+st.ID)
	writeJSON(w, http.StatusAccepted, st)
}

func (s *Server) list(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"runs": s.Manager.List()})
}

// lookup finds the run named in the path, answering 400/404 itself when it can't.
func (s *Server) lookup(w http.ResponseWriter, r *http.Request) (*engine.Run, bool) {
	id := r.PathValue("id")
	if !runIDRe.MatchString(id) {
		writeError(w, http.StatusBadRequest, "bad run id (expected run_ and 16 hex characters)")
		return nil, false
	}
	run, ok := s.Manager.Run(id)
	if !ok {
		writeError(w, http.StatusNotFound, "run not found (runs are kept in memory and lost when the sidecar restarts)")
		return nil, false
	}
	return run, true
}

// waitFor long-polls: with ?wait=N it holds the request until the run
// finishes, N seconds pass (at most MaxWait), or the caller goes away.
func waitFor(w http.ResponseWriter, r *http.Request, run *engine.Run) bool {
	raw := r.URL.Query().Get("wait")
	if raw == "" {
		return true
	}
	secs, err := strconv.ParseFloat(raw, 64)
	if err != nil || secs < 0 {
		writeError(w, http.StatusBadRequest, "wait must be a number of seconds")
		return false
	}
	d := min(time.Duration(secs*float64(time.Second)), MaxWait)
	if d <= 0 {
		return true
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-run.Done():
	case <-timer.C:
	case <-r.Context().Done():
	}
	return true
}

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	run, ok := s.lookup(w, r)
	if !ok || !waitFor(w, r, run) {
		return
	}
	writeJSON(w, http.StatusOK, run.Snapshot())
}

// resultResponse is GET /v1/runs/{id}/result.
type resultResponse struct {
	ID          string            `json:"id"`
	State       engine.RunState   `json:"state"`
	Done        bool              `json:"done"`
	Result      *engine.RunResult `json:"result,omitempty"`
	Error       string            `json:"error,omitempty"`
	TokensUsed  int               `json:"tokens_used"`
	TokenBudget int               `json:"token_budget"`
}

func (s *Server) result(w http.ResponseWriter, r *http.Request) {
	run, ok := s.lookup(w, r)
	if !ok || !waitFor(w, r, run) {
		return
	}
	st := run.Snapshot()
	body := resultResponse{ID: st.ID, State: st.State, Done: st.State.Terminal(), Result: st.Result, Error: st.Error,
		TokensUsed: st.TokensUsed, TokenBudget: st.TokenBudget}
	status := http.StatusOK
	if !body.Done {
		status = http.StatusAccepted
	}
	writeJSON(w, status, body)
}

func (s *Server) cancel(w http.ResponseWriter, r *http.Request) {
	if !runIDRe.MatchString(r.PathValue("id")) {
		writeError(w, http.StatusBadRequest, "bad run id (expected run_ and 16 hex characters)")
		return
	}
	st, found, cancelled := s.Manager.Cancel(r.PathValue("id"))
	if !found {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}
	if !cancelled {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "run already finished", "run": st})
		return
	}
	writeJSON(w, http.StatusAccepted, st)
}

func writePlanError(w http.ResponseWriter, err error) {
	var ve *plan.ValidationError
	switch {
	case errors.As(err, &ve):
		writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": "invalid plan", "problems": ve.Problems})
	case errors.Is(err, engine.ErrNoPlanner):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, engine.ErrShuttingDown):
		writeError(w, http.StatusServiceUnavailable, err.Error())
	case errors.Is(err, plan.ErrEmptyTask):
		writeError(w, http.StatusBadRequest, err.Error())
	default:
		writeError(w, http.StatusBadGateway, err.Error())
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		var tooBig *http.MaxBytesError
		switch {
		case errors.Is(err, io.EOF):
			writeError(w, http.StatusBadRequest, "request body is empty; send a JSON object")
		case errors.As(err, &tooBig):
			writeError(w, http.StatusRequestEntityTooLarge, fmt.Sprintf("request body is larger than %d bytes", maxBodyBytes))
		default:
			writeError(w, http.StatusBadRequest, "bad JSON body: "+err.Error())
		}
		return false
	}
	if dec.More() {
		writeError(w, http.StatusBadRequest, "bad JSON body: send a single JSON object")
		return false
	}
	return true
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
