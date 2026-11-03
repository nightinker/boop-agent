package agents

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"boop-agent/orchestrator/engine"
	"boop-agent/orchestrator/plan"
)

// DefaultBoopURL is where Boop's server listens on the Mac.
const DefaultBoopURL = "http://127.0.0.1:3456"

// Boop runs a task as one of Boop's own sub-agents, through the same path
// spawn_agent uses (POST /orchestrator/spawn on Boop's server). Cancelling the
// task's context drops the request, and Boop aborts the sub-agent.
type Boop struct {
	BaseURL string
	Client  *http.Client // should have no overall timeout; sub-agents can run for minutes
	// ConversationID optionally ties spawned agents to a conversation (draft staging etc.).
	ConversationID string
}

func (b *Boop) Spec() plan.AgentSpec {
	return plan.AgentSpec{
		Name:             "boop",
		Description:      "One of Boop's sub-agents with real tools: web search and fetch, plus the listed integrations (email, calendar, browser, etc.). Use for anything that has to look something up or act in the world.",
		UsesIntegrations: true,
	}
}

func (b *Boop) base() string {
	if b.BaseURL == "" {
		return DefaultBoopURL
	}
	return strings.TrimRight(b.BaseURL, "/")
}

func (b *Boop) client() *http.Client {
	if b.Client != nil {
		return b.Client
	}
	return http.DefaultClient
}

type spawnRequest struct {
	Task           string   `json:"task"`
	Integrations   []string `json:"integrations"`
	Name           string   `json:"name,omitempty"`
	ConversationID string   `json:"conversationId,omitempty"`
}

type spawnResponse struct {
	AgentID      string `json:"agentId"`
	Status       string `json:"status"`
	Result       string `json:"result"`
	UsageLimited bool   `json:"usageLimited"`
	// Automatic retries the sub-agent already made after dropped connections.
	AutoRetries int    `json:"autoRetries"`
	Error       string `json:"error"`
	Usage       *struct {
		InputTokens  int `json:"inputTokens"`
		OutputTokens int `json:"outputTokens"`
	} `json:"usage"`
}

// tokens is what the sub-agent's run is charged against the run's budget:
// fresh input plus output tokens. Cache reads and writes aren't charged until
// token calibration lands (they'd swamp the cost-hint estimates).
func (s spawnResponse) tokens() int {
	if s.Usage == nil {
		return 0
	}
	return max(s.Usage.InputTokens, 0) + max(s.Usage.OutputTokens, 0)
}

// BridgeError is a sub-agent failure reported by Boop.
type BridgeError struct {
	AgentID string
	Status  string
	Message string
}

func (e *BridgeError) Error() string {
	id := ""
	if e.AgentID != "" {
		id = " " + e.AgentID
	}
	return fmt.Sprintf("boop agent%s %s: %s", id, e.Status, e.Message)
}

// Run implements engine.Agent.
func (b *Boop) Run(ctx context.Context, in engine.Input) (engine.Output, error) {
	integrations := in.Task.Integrations
	if integrations == nil {
		integrations = []string{}
	}
	name := in.Task.ID
	if in.Task.Title != "" {
		name = in.Task.Title
	}
	conversationID := in.ConversationID
	if conversationID == "" {
		conversationID = b.ConversationID
	}
	body, err := json.Marshal(spawnRequest{Task: TaskText(in), Integrations: integrations, Name: name, ConversationID: conversationID})
	if err != nil {
		return engine.Output{}, engine.Permanent(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, b.base()+"/orchestrator/spawn", bytes.NewReader(body))
	if err != nil {
		return engine.Output{}, engine.Permanent(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := b.client().Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return engine.Output{}, ctx.Err()
		}
		return engine.Output{}, fmt.Errorf("reaching Boop: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		if ctx.Err() != nil {
			return engine.Output{}, ctx.Err()
		}
		return engine.Output{}, fmt.Errorf("reading Boop's answer: %w", err)
	}
	var out spawnResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return engine.Output{}, fmt.Errorf("Boop answered HTTP %d with non-JSON: %.200s", res.StatusCode, raw)
	}
	switch {
	case res.StatusCode >= 400 && res.StatusCode < 500:
		// Bad request (unknown integration, empty task): retrying won't help.
		return engine.Output{}, engine.Permanent(&BridgeError{Status: "rejected", Message: out.Error})
	case res.StatusCode >= 500:
		return engine.Output{}, &BridgeError{Status: "failed", Message: firstNonEmpty(out.Error, out.Result)}
	}
	switch out.Status {
	case "completed":
		return engine.Output{Text: out.Result, Tokens: out.tokens()}, nil
	case "cancelled":
		if ctx.Err() != nil {
			return engine.Output{}, ctx.Err()
		}
		// Cancelled on Boop's side (e.g. from the dashboard): respect that.
		return engine.Output{}, engine.Permanent(&BridgeError{AgentID: out.AgentID, Status: "cancelled", Message: "cancelled in Boop"})
	case "failed":
		err := &BridgeError{AgentID: out.AgentID, Status: "failed", Message: firstNonEmpty(out.Result, out.Error, "no details")}
		if out.UsageLimited {
			// The model's spend limit: retrying now just fails again.
			return engine.Output{Tokens: out.tokens()}, engine.Permanent(err)
		}
		if out.AutoRetries > 0 {
			// The sub-agent already retried its dropped connection; retrying
			// the whole task here too would multiply the attempts (and cost).
			return engine.Output{Tokens: out.tokens()}, engine.Permanent(err)
		}
		return engine.Output{Tokens: out.tokens()}, err
	default:
		return engine.Output{}, fmt.Errorf("Boop answered with unknown status %q", out.Status)
	}
}

// Integrations asks Boop which integrations its sub-agents can use.
func (b *Boop) Integrations(ctx context.Context) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, b.base()+"/orchestrator/integrations", nil)
	if err != nil {
		return nil, err
	}
	res, err := b.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("Boop answered HTTP %d", res.StatusCode)
	}
	var body struct {
		Integrations []string `json:"integrations"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil {
		return nil, err
	}
	if body.Integrations == nil {
		return nil, errors.New("Boop sent no integrations list")
	}
	return body.Integrations, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
