package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"boop-agent/orchestrator/engine"
	"boop-agent/orchestrator/llm"
	"boop-agent/orchestrator/plan"
)

type blockingAgent struct{ started chan struct{} }

func (blockingAgent) Spec() plan.AgentSpec {
	return plan.AgentSpec{Name: "block", Description: "waits"}
}
func (a blockingAgent) Run(ctx context.Context, in engine.Input) (engine.Output, error) {
	a.started <- struct{}{}
	<-ctx.Done()
	return engine.Output{}, ctx.Err()
}

type echoAgent struct{}

func (echoAgent) Spec() plan.AgentSpec { return plan.AgentSpec{Name: "echo", Description: "echo"} }
func (echoAgent) Run(ctx context.Context, in engine.Input) (engine.Output, error) {
	return engine.Output{Text: in.Task.Input}, nil
}

const plannerReply = `{"goal":"g","tasks":[{"id":"a","agent":"echo","input":"hello","cost_hint":"low"}]}`

func newServer(t *testing.T, token string, withPlanner bool) (*httptest.Server, chan struct{}) {
	t.Helper()
	started := make(chan struct{}, 4)
	agents := []engine.Agent{echoAgent{}, blockingAgent{started}}
	cfg := engine.Config{Agents: agents}
	if withPlanner {
		specs := []plan.AgentSpec{agents[0].Spec(), agents[1].Spec()}
		cfg.Planner = &plan.Planner{LLM: &llm.Mock{Replies: []llm.MockReply{{Text: plannerReply}}}, Agents: specs}
	}
	m := engine.NewManager(cfg)
	srv := httptest.NewServer((&Server{Manager: m, Token: token}).Handler())
	t.Cleanup(func() {
		srv.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = m.Shutdown(ctx)
	})
	return srv, started
}

func do(t *testing.T, method, url string, body any, token string) (int, map[string]any) {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if s, ok := body.(string); ok {
			buf.WriteString(s)
		} else {
			_ = json.NewEncoder(&buf).Encode(body)
		}
	}
	req, _ := http.NewRequest(method, url, &buf)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func waitState(t *testing.T, url, want string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, run := do(t, "GET", url, nil, "")
		if run["state"] == want {
			return run
		}
		if time.Now().After(deadline) {
			t.Fatalf("state %v, want %s", run["state"], want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestSubmitPlanAndGetStatus(t *testing.T) {
	srv, _ := newServer(t, "", false)
	code, run := do(t, "POST", srv.URL+"/v1/runs", map[string]any{"plan": plan.Plan{Tasks: []plan.Task{
		{ID: "a", Agent: "echo", Input: "one", CostHint: "low"},
		{ID: "b", Agent: "echo", Input: "two", CostHint: "medium", DependsOn: []string{"a"}},
	}}, "max_tokens": 50000}, "")
	if code != http.StatusAccepted || run["state"] != "RUNNING" {
		t.Fatalf("%d %v", code, run)
	}
	id := run["id"].(string)
	final := waitState(t, srv.URL+"/v1/runs/"+id, "SUCCEEDED")
	if final["output"] != "two" || final["token_budget"].(float64) != 50000 {
		t.Fatalf("%v", final)
	}
	_, list := do(t, "GET", srv.URL+"/v1/runs", nil, "")
	if runs := list["runs"].([]any); len(runs) != 1 {
		t.Fatalf("list %v", list)
	}
}

func TestSubmitInvalidPlan(t *testing.T) {
	srv, _ := newServer(t, "", false)
	code, body := do(t, "POST", srv.URL+"/v1/runs", map[string]any{"plan": plan.Plan{Tasks: []plan.Task{
		{ID: "a", Agent: "ghost", Input: "x", CostHint: "low", DependsOn: []string{"a"}},
	}}}, "")
	if code != http.StatusUnprocessableEntity || len(body["problems"].([]any)) < 2 {
		t.Fatalf("%d %v", code, body)
	}
}

func TestSubmitBadRequests(t *testing.T) {
	srv, _ := newServer(t, "", false)
	cases := []any{
		`{"task":"x","plan":{"tasks":[]}}`, // both
		`{}`,                               // neither
		`{"task":"x","bogus":1}`,           // unknown field
		`not json`,
		`{"task":"x","max_parallel":-1}`,
	}
	for _, c := range cases {
		if code, _ := do(t, "POST", srv.URL+"/v1/runs", c, ""); code != http.StatusBadRequest {
			t.Errorf("%v: got %d", c, code)
		}
	}
	// A task with no planner configured.
	if code, _ := do(t, "POST", srv.URL+"/v1/runs", map[string]string{"task": "x"}, ""); code != http.StatusServiceUnavailable {
		t.Errorf("no planner: got %d", code)
	}
	if code, _ := do(t, "GET", srv.URL+"/v1/runs/run_0000000000000000", nil, ""); code != http.StatusNotFound {
		t.Errorf("unknown run: got %d", code)
	}
	if code, _ := do(t, "POST", srv.URL+"/v1/runs/run_0000000000000000/cancel", nil, ""); code != http.StatusNotFound {
		t.Errorf("unknown cancel: got %d", code)
	}
}

func TestSubmitTaskAndPlanEndpoint(t *testing.T) {
	srv, _ := newServer(t, "", true)
	code, res := do(t, "POST", srv.URL+"/v1/plan", map[string]string{"task": "say hello"}, "")
	if code != http.StatusOK || len(res["plan"].(map[string]any)["tasks"].([]any)) != 1 {
		t.Fatalf("%d %v", code, res)
	}
	if code, _ := do(t, "POST", srv.URL+"/v1/plan", map[string]string{"task": " "}, ""); code != http.StatusBadRequest {
		t.Fatalf("blank task: %d", code)
	}
	code, run := do(t, "POST", srv.URL+"/v1/runs", map[string]string{"task": "say hello"}, "")
	if code != http.StatusAccepted {
		t.Fatalf("%d %v", code, run)
	}
	final := waitState(t, srv.URL+"/v1/runs/"+run["id"].(string), "SUCCEEDED")
	if final["output"] != "hello" || final["task"] != "say hello" {
		t.Fatalf("%v", final)
	}
}

func TestCancelEndpoint(t *testing.T) {
	srv, started := newServer(t, "", false)
	_, run := do(t, "POST", srv.URL+"/v1/runs", map[string]any{"plan": plan.Plan{Tasks: []plan.Task{
		{ID: "a", Agent: "block", Input: "wait", CostHint: "low"},
		{ID: "b", Agent: "echo", Input: "after", CostHint: "low", DependsOn: []string{"a"}},
	}}}, "")
	<-started
	id := run["id"].(string)
	if code, _ := do(t, "POST", srv.URL+"/v1/runs/"+id+"/cancel", nil, ""); code != http.StatusAccepted {
		t.Fatalf("cancel: %d", code)
	}
	final := waitState(t, srv.URL+"/v1/runs/"+id, "CANCELLED")
	for _, task := range final["tasks"].([]any) {
		if s := task.(map[string]any)["state"]; s != "CANCELLED" {
			t.Fatalf("task state %v", s)
		}
	}
	if code, _ := do(t, "POST", srv.URL+"/v1/runs/"+id+"/cancel", nil, ""); code != http.StatusConflict {
		t.Fatalf("second cancel: %d", code)
	}
}

func TestTokenAuth(t *testing.T) {
	srv, _ := newServer(t, "s3cret-test", false)
	if code, _ := do(t, "GET", srv.URL+"/healthz", nil, ""); code != http.StatusOK {
		t.Fatalf("healthz should be open: %d", code)
	}
	if code, _ := do(t, "GET", srv.URL+"/v1/agents", nil, ""); code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", code)
	}
	code, body := do(t, "GET", srv.URL+"/v1/agents", nil, "s3cret-test")
	if code != http.StatusOK || !strings.Contains(toJSON(body), `"name":"echo"`) {
		t.Fatalf("%d %v", code, body)
	}
}

func toJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

func TestHealthzReportsPlannerMergerAndLLM(t *testing.T) {
	m := engine.NewManager(engine.Config{
		Agents:  []engine.Agent{echoAgent{}},
		Planner: &plan.Planner{LLM: &llm.Mock{Replies: []llm.MockReply{{Text: plannerReply}}}},
		Merger:  mergerFunc(nil),
		LLM:     "boop",
	})
	srv := httptest.NewServer((&Server{Manager: m}).Handler())
	defer srv.Close()
	code, body := do(t, "GET", srv.URL+"/healthz", nil, "")
	if code != http.StatusOK || body["planner"] != true || body["merger"] != true || body["llm"] != "boop" {
		t.Fatalf("%d %v", code, body)
	}

	bare, _ := newServer(t, "", false)
	_, body = do(t, "GET", bare.URL+"/healthz", nil, "")
	if body["planner"] != false || body["merger"] != false || body["llm"] != "" {
		t.Fatalf("%v", body)
	}
}

type mergerFunc func(ctx context.Context, in engine.MergeInput) (engine.MergeOutput, error)

func (f mergerFunc) Merge(ctx context.Context, in engine.MergeInput) (engine.MergeOutput, error) {
	return f(ctx, in)
}
