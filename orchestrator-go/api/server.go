// Package api is the sidecar's HTTP API.
//
//	GET  /healthz                 liveness
//	GET  /v1/agents               agents the planner can use
//	POST /v1/plan                 {"task"} -> a validated plan, not run
//	POST /v1/runs                 {"task"} or {"plan"}, optional max_tokens / max_parallel -> 202 + run
//	GET  /v1/runs                 every run in memory, newest first
//	GET  /v1/runs/{id}            one run's status
//	POST /v1/runs/{id}/cancel     cancel a run
package api

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"boop-agent/orchestrator/engine"
	"boop-agent/orchestrator/plan"
)

const maxBodyBytes = 1 << 20

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
}

func (s *Server) submit(w http.ResponseWriter, r *http.Request) {
	var req runRequest
	if !decode(w, r, &req) {
		return
	}
	task := strings.TrimSpace(req.Task)
	if (task == "") == (req.Plan == nil) {
		writeError(w, http.StatusBadRequest, `send exactly one of "task" or "plan"`)
		return
	}
	if req.MaxTokens < 0 || req.MaxParallel < 0 {
		writeError(w, http.StatusBadRequest, "max_tokens and max_parallel must be positive")
		return
	}
	o := engine.Overrides{MaxTokens: req.MaxTokens, MaxParallel: req.MaxParallel}
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

func (s *Server) get(w http.ResponseWriter, r *http.Request) {
	run, ok := s.Manager.Run(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "run not found")
		return
	}
	writeJSON(w, http.StatusOK, run.Snapshot())
}

func (s *Server) cancel(w http.ResponseWriter, r *http.Request) {
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
		writeError(w, http.StatusBadRequest, "bad JSON body: "+err.Error())
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
