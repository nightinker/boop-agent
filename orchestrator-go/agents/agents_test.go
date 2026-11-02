package agents

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"boop-agent/orchestrator/engine"
	"boop-agent/orchestrator/llm"
	"boop-agent/orchestrator/plan"
)

func boopServer(t *testing.T, h func(w http.ResponseWriter, r *http.Request, body spawnRequest)) (*Boop, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/orchestrator/integrations" {
			_, _ = w.Write([]byte(`{"integrations":["gmail","browser"]}`))
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/orchestrator/spawn" {
			http.NotFound(w, r)
			return
		}
		var body spawnRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("bad body: %v", err)
		}
		h(w, r, body)
	}))
	t.Cleanup(srv.Close)
	return &Boop{BaseURL: srv.URL}, srv
}

func input() engine.Input {
	return engine.Input{
		Task: plan.Task{ID: "mail", Title: "Check bills", Agent: "boop", Input: "Find unpaid bills", Integrations: []string{"gmail"},
			CostHint: plan.CostMed, Scout: &plan.Scout{Narrow: []string{"subject:invoice"}}},
		Deps: []engine.DepOutput{{ID: "prev", Output: "earlier result"}},
	}
}

func TestBoopBridgeSuccess(t *testing.T) {
	var got spawnRequest
	b, _ := boopServer(t, func(w http.ResponseWriter, r *http.Request, body spawnRequest) {
		got = body
		_, _ = w.Write([]byte(`{"agentId":"agent_1","status":"completed","result":"2 bills"}`))
	})
	out, err := b.Run(context.Background(), input())
	if err != nil || out.Text != "2 bills" {
		t.Fatalf("out %+v err %v", out, err)
	}
	if got.Name != "Check bills" || len(got.Integrations) != 1 || got.Integrations[0] != "gmail" {
		t.Fatalf("request %+v", got)
	}
	for _, want := range []string{"Find unpaid bills", "- subject:invoice", "### prev\nearlier result"} {
		if !strings.Contains(got.Task, want) {
			t.Fatalf("task text missing %q:\n%s", want, got.Task)
		}
	}
	list, err := b.Integrations(context.Background())
	if err != nil || strings.Join(list, ",") != "gmail,browser" {
		t.Fatalf("integrations %v %v", list, err)
	}
}

func TestBoopBridgeFailures(t *testing.T) {
	cases := []struct {
		name      string
		status    int
		body      string
		permanent bool
		contains  string
	}{
		{"agent failed", 200, `{"agentId":"agent_2","status":"failed","result":"tool crashed"}`, false, "tool crashed"},
		{"usage limit", 200, `{"agentId":"agent_3","status":"failed","result":"limit","usageLimited":true}`, true, "limit"},
		{"cancelled in boop", 200, `{"agentId":"agent_4","status":"cancelled","result":""}`, true, "cancelled in Boop"},
		{"bad request", 400, `{"error":"unknown integrations: slack"}`, true, "slack"},
		{"server error", 500, `{"status":"failed","error":"convex down"}`, false, "convex down"},
		{"not json", 502, `<html>bad gateway</html>`, false, "non-JSON"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b, _ := boopServer(t, func(w http.ResponseWriter, r *http.Request, _ spawnRequest) {
				w.WriteHeader(c.status)
				_, _ = w.Write([]byte(c.body))
			})
			_, err := b.Run(context.Background(), input())
			if err == nil || !strings.Contains(err.Error(), c.contains) || engine.IsPermanent(err) != c.permanent {
				t.Fatalf("err %v (permanent %v)", err, engine.IsPermanent(err))
			}
		})
	}
}

func TestBoopBridgeUnreachableIsRetryable(t *testing.T) {
	_, srv := boopServer(t, nil)
	b := &Boop{BaseURL: srv.URL}
	srv.Close()
	_, err := b.Run(context.Background(), input())
	if err == nil || engine.IsPermanent(err) {
		t.Fatalf("want retryable error, got %v", err)
	}
}

func TestBoopBridgeCancelDropsRequest(t *testing.T) {
	serverSawCancel := make(chan struct{})
	started := make(chan struct{})
	b, _ := boopServer(t, func(w http.ResponseWriter, r *http.Request, _ spawnRequest) {
		close(started)
		<-r.Context().Done() // Boop's route aborts the sub-agent on this
		close(serverSawCancel)
	})
	ctx, cancel := context.WithCancel(context.Background())
	errc := make(chan error, 1)
	go func() { _, err := b.Run(ctx, input()); errc <- err }()
	<-started
	cancel()
	if err := <-errc; !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
	select {
	case <-serverSawCancel:
	case <-time.After(5 * time.Second):
		t.Fatal("Boop never saw the request drop")
	}
}

func TestBoopBridgeInEngineRetriesThenSucceeds(t *testing.T) {
	var calls int32
	b, _ := boopServer(t, func(w http.ResponseWriter, r *http.Request, _ spawnRequest) {
		if atomic.AddInt32(&calls, 1) == 1 {
			_, _ = w.Write([]byte(`{"agentId":"a1","status":"failed","result":"flaky"}`))
			return
		}
		_, _ = w.Write([]byte(`{"agentId":"a2","status":"completed","result":"ok"}`))
	})
	m := engine.NewManager(engine.Config{Agents: []engine.Agent{b, Join{}},
		Options: engine.Options{BackoffBase: time.Millisecond}})
	st, err := m.SubmitPlan(context.Background(), plan.Plan{Tasks: []plan.Task{
		{ID: "a", Agent: "boop", Input: "look", CostHint: plan.CostLow},
		{ID: "j", Agent: "join", Input: "collect", CostHint: plan.CostLow, DependsOn: []string{"a"}},
	}}, engine.Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	r, _ := m.Run(st.ID)
	<-r.Done()
	final := r.Snapshot()
	if final.State != engine.RunSucceeded || final.Tasks[0].Attempts != 2 || final.Output != "## a\nok" {
		t.Fatalf("%+v", final)
	}
	// The bridge reports no usage, so the low estimate is charged.
	if final.Tasks[0].Tokens != engine.DefaultCostTokens[plan.CostLow] {
		t.Fatalf("tokens %d", final.Tasks[0].Tokens)
	}
}

func TestNativeAgents(t *testing.T) {
	out, _ := Echo{}.Run(context.Background(), engine.Input{Task: plan.Task{Input: "hi"}})
	if out.Text != "hi" {
		t.Fatal("echo")
	}
	if _, err := (Join{}).Run(context.Background(), engine.Input{}); !engine.IsPermanent(err) {
		t.Fatal("join without deps should fail permanently")
	}
	mock := &llm.Mock{Replies: []llm.MockReply{{Text: " summary ", Tokens: 7}}}
	out, err := LLM{Provider: mock}.Run(context.Background(), input())
	if err != nil || out.Text != "summary" || out.Tokens != 7 {
		t.Fatalf("llm %+v %v", out, err)
	}
	if msg := mock.Calls()[0].Messages[0].Content; !strings.Contains(msg, "earlier result") {
		t.Fatalf("llm did not get dep output: %s", msg)
	}
	_, err = LLM{Provider: &llm.Mock{Replies: []llm.MockReply{{Err: &llm.StatusError{Status: 400}}}}}.Run(context.Background(), input())
	if !engine.IsPermanent(err) {
		t.Fatal("400 should be permanent")
	}
}

func TestTaskTextTruncatesLongDeps(t *testing.T) {
	in := engine.Input{Task: plan.Task{Input: "x"}, Deps: []engine.DepOutput{{ID: "d", Output: strings.Repeat("a", MaxDepChars+10)}}}
	if text := TaskText(in); !strings.Contains(text, "(truncated)") || len(text) > MaxDepChars+200 {
		t.Fatal("not truncated")
	}
}

func TestBoopBridgeReportsUsageAndConversation(t *testing.T) {
	var got spawnRequest
	b, _ := boopServer(t, func(w http.ResponseWriter, r *http.Request, body spawnRequest) {
		got = body
		_, _ = w.Write([]byte(`{"agentId":"agent_1","status":"completed","result":"ok","usage":{"inputTokens":1200,"outputTokens":300,"cacheReadTokens":90000}}`))
	})
	b.ConversationID = "fallback"
	in := input()
	in.ConversationID = "sms:run"
	out, err := b.Run(context.Background(), in)
	if err != nil || out.Tokens != 1500 {
		t.Fatalf("out %+v err %v (cache reads aren't charged)", out, err)
	}
	if got.ConversationID != "sms:run" {
		t.Fatalf("conversation %q", got.ConversationID)
	}
	if _, err := b.Run(context.Background(), input()); err != nil || got.ConversationID != "fallback" {
		t.Fatalf("fallback conversation %q %v", got.ConversationID, err)
	}
}
