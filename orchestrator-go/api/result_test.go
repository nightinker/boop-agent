package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"boop-agent/orchestrator/agents"
	"boop-agent/orchestrator/engine"
	"boop-agent/orchestrator/llm"
	"boop-agent/orchestrator/merge"
	"boop-agent/orchestrator/plan"
)

func TestRunRequestValidation(t *testing.T) {
	srv, _ := newServer(t, "", false)
	okPlan := map[string]any{"tasks": []any{map[string]any{"id": "a", "agent": "echo", "input": "x", "cost_hint": "low"}}}
	cases := []struct {
		name string
		body any
		code int
		msg  string
	}{
		{"empty body", "", 400, "request body is empty"},
		{"not json", "{nope", 400, "bad JSON body"},
		{"two objects", `{"task":"a"}{"task":"b"}`, 400, "single JSON object"},
		{"unknown field", `{"task":"a","bogus":1}`, 400, "unknown field"},
		{"neither", map[string]any{}, 400, "exactly one of"},
		{"both", map[string]any{"task": "x", "plan": okPlan}, 400, "exactly one of"},
		{"task too long", map[string]any{"task": strings.Repeat("x", MaxTaskChars+1)}, 400, "longer than"},
		{"negative tokens", map[string]any{"plan": okPlan, "max_tokens": -1}, 400, "max_tokens"},
		{"huge tokens", map[string]any{"plan": okPlan, "max_tokens": MaxRunTokens + 1}, 400, "max_tokens"},
		{"too parallel", map[string]any{"plan": okPlan, "max_parallel": engine.MaxParallelLimit + 1}, 400, "max_parallel"},
		{"long conversation id", map[string]any{"plan": okPlan, "conversation_id": strings.Repeat("c", 201)}, 400, "conversation_id"},
		{"empty plan", map[string]any{"plan": map[string]any{"tasks": []any{}}}, 400, "no tasks"},
		{"too big", `{"task":"` + strings.Repeat("x", maxBodyBytes) + `"}`, 413, "larger than"},
	}
	for _, c := range cases {
		code, body := do(t, "POST", srv.URL+"/v1/runs", c.body, "")
		if code != c.code || !strings.Contains(body["error"].(string), c.msg) {
			t.Errorf("%s: %d %v", c.name, code, body)
		}
	}
}

func TestRunIDsAreChecked(t *testing.T) {
	srv, _ := newServer(t, "", false)
	for _, path := range []string{"/v1/runs/x", "/v1/runs/x/result"} {
		if code, _ := do(t, "GET", srv.URL+path, nil, ""); code != http.StatusBadRequest {
			t.Errorf("%s: %d", path, code)
		}
	}
	if code, _ := do(t, "POST", srv.URL+"/v1/runs/x/cancel", nil, ""); code != http.StatusBadRequest {
		t.Error("cancel with a bad id")
	}
	if code, _ := do(t, "GET", srv.URL+"/v1/runs/run_0000000000000000/result", nil, ""); code != http.StatusNotFound {
		t.Error("unknown run result")
	}
	if code, body := do(t, "GET", srv.URL+"/v1/runs/run_0000000000000000?wait=abc", nil, ""); code != 404 {
		t.Errorf("unknown run with wait: %d %v", code, body)
	}
}

func TestResultEndpointLongPolls(t *testing.T) {
	srv, started := newServer(t, "", false)
	code, run := do(t, "POST", srv.URL+"/v1/runs", map[string]any{"plan": map[string]any{"tasks": []any{
		map[string]any{"id": "a", "agent": "block", "input": "x", "cost_hint": "low"}}}}, "")
	if code != http.StatusAccepted {
		t.Fatalf("%d %v", code, run)
	}
	id := run["id"].(string)
	<-started

	code, body := do(t, "GET", srv.URL+"/v1/runs/"+id+"/result", nil, "")
	if code != http.StatusAccepted || body["done"] != false || body["result"] != nil {
		t.Fatalf("running: %d %v", code, body)
	}
	if code, _ := do(t, "GET", srv.URL+"/v1/runs/"+id+"/result?wait=-1", nil, ""); code != 400 {
		t.Fatal("negative wait")
	}

	go func() {
		time.Sleep(100 * time.Millisecond)
		do(t, "POST", srv.URL+"/v1/runs/"+id+"/cancel", nil, "")
	}()
	start := time.Now()
	code, body = do(t, "GET", srv.URL+"/v1/runs/"+id+"/result?wait=10", nil, "")
	if time.Since(start) > 5*time.Second {
		t.Fatal("wait didn't return when the run finished")
	}
	if code != http.StatusOK || body["done"] != true || body["state"] != "CANCELLED" {
		t.Fatalf("finished: %d %v", code, body)
	}
}

// fakeBoop stands in for Boop's /orchestrator routes, like the TypeScript bridge.
func fakeBoop(t *testing.T) (*httptest.Server, *[]map[string]any) {
	var mu sync.Mutex
	var seen []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/orchestrator/integrations":
			_, _ = w.Write([]byte(`{"integrations":["gmail","browser"]}`))
		case "/orchestrator/spawn":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			seen = append(seen, body)
			mu.Unlock()
			task := body["task"].(string)
			switch {
			case strings.Contains(task, "Find flights"):
				_ = json.NewEncoder(w).Encode(map[string]any{"agentId": "agent_f", "status": "completed",
					"result": "Cheapest: $120 on https://flights.example/deal?id=7&src=x",
					"usage":  map[string]int{"inputTokens": 900, "outputTokens": 100}})
			case strings.Contains(task, "Check the calendar"):
				_ = json.NewEncoder(w).Encode(map[string]any{"agentId": "agent_c", "status": "failed",
					"result": "usage limit", "usageLimited": true})
			default:
				http.Error(w, `{"error":"unexpected"}`, 500)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &seen
}

// A real run through the HTTP API: planned from a task, two Boop sub-agents
// over the bridge (one fails), then the report agent merges what's there.
func TestEndToEndTaskRunWithBoopBridgeAndMerge(t *testing.T) {
	boopSrv, seen := fakeBoop(t)
	boop := &agents.Boop{BaseURL: boopSrv.URL}
	registered := []engine.Agent{boop, agents.Join{}}
	const planJSON = `{"goal":"Plan a trip","tasks":[
	 {"id":"flights","title":"Flights","agent":"boop","input":"Find flights to Lisbon","integrations":["browser"],"cost_hint":"med","scout":{"narrow":["next weekend"]}},
	 {"id":"cal","title":"Calendar","agent":"boop","input":"Check the calendar for next weekend","integrations":["gmail"],"cost_hint":"low"},
	 {"id":"all","title":"Collect","agent":"join","input":"collect","depends_on":["flights"],"cost_hint":"low"}]}`
	model := &llm.Mock{Fn: func(ctx context.Context, req llm.Request) (llm.Response, error) {
		if strings.Contains(req.System, "final answer") {
			// The report agent: drop the URL's query string to prove it gets restored verbatim.
			return llm.Response{Text: "Flights from $120 (https://flights.example/deal). I couldn't check your calendar.", InputTokens: 400, OutputTokens: 50}, nil
		}
		return llm.Response{Text: planJSON, InputTokens: 300, OutputTokens: 200}, nil
	}}
	specs := []plan.AgentSpec{boop.Spec(), agents.Join{}.Spec()}
	m := engine.NewManager(engine.Config{
		Agents:       registered,
		Planner:      &plan.Planner{LLM: model, Agents: specs, Integrations: boop.Integrations},
		Merger:       merge.LLM{Provider: model},
		Integrations: boop.Integrations,
		Options:      engine.Options{MaxTokens: 60_000, BackoffBase: time.Millisecond},
	})
	srv := httptest.NewServer((&Server{Manager: m}).Handler())
	t.Cleanup(func() { srv.Close(); _ = m.Shutdown(context.Background()) })

	code, run := do(t, "POST", srv.URL+"/v1/runs", map[string]any{"task": "Plan my Lisbon trip", "conversation_id": "sms:test"}, "")
	if code != http.StatusAccepted {
		t.Fatalf("%d %v", code, run)
	}
	code, res := do(t, "GET", srv.URL+"/v1/runs/"+run["id"].(string)+"/result?wait=10", nil, "")
	if code != http.StatusOK || res["done"] != true {
		t.Fatalf("%d %v", code, res)
	}
	result := res["result"].(map[string]any)
	answer := result["answer"].(string)
	if result["method"] != "llm" || !strings.Contains(answer, "I couldn't check your calendar") ||
		!strings.Contains(answer, "https://flights.example/deal?id=7&src=x") {
		t.Fatalf("result %v", result)
	}
	if res["state"] != "FAILED" { // the calendar step failed for real
		t.Fatalf("state %v", res["state"])
	}
	inc := result["incomplete"].([]any)
	if len(inc) != 1 || inc[0].(map[string]any)["id"] != "cal" {
		t.Fatalf("incomplete %v", inc)
	}

	// Step results and token accounting are in the status.
	_, st := do(t, "GET", srv.URL+"/v1/runs/"+run["id"].(string), nil, "")
	tasks := map[string]map[string]any{}
	for _, raw := range st["tasks"].([]any) {
		ts := raw.(map[string]any)
		tasks[ts["id"].(string)] = ts
	}
	if tasks["flights"]["tokens"].(float64) != 1000 || tasks["cal"]["attempts"].(float64) != 1 || tasks["all"]["state"] != "SUCCEEDED" {
		t.Fatalf("tasks %v", tasks)
	}
	if used := st["tokens_used"].(float64); used <= 1000 || used > 60_000 {
		t.Fatalf("tokens used %v", used)
	}
	// Every sub-agent was tied to the conversation, with scout hints in its task.
	for _, body := range *seen {
		if body["conversationId"] != "sms:test" {
			t.Fatalf("bridge body %v", body)
		}
	}
	if !strings.Contains((*seen)[0]["task"].(string)+(*seen)[len(*seen)-1]["task"].(string), "next weekend") {
		t.Fatal("scout hints missing")
	}
}
