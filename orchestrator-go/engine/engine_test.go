package engine

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"boop-agent/orchestrator/llm"
	"boop-agent/orchestrator/plan"
)

type funcAgent struct {
	name string
	fn   func(ctx context.Context, in Input) (Output, error)
}

func (a funcAgent) Spec() plan.AgentSpec { return plan.AgentSpec{Name: a.name, Description: "test"} }
func (a funcAgent) Run(ctx context.Context, in Input) (Output, error) {
	return a.fn(ctx, in)
}

func fast(o Options) Options {
	o.BackoffBase = time.Millisecond
	o.BackoffMax = 2 * time.Millisecond
	return o
}

func task(id string, cost plan.CostHint, deps ...string) plan.Task {
	return plan.Task{ID: id, Agent: "t", Input: "do " + id, CostHint: cost, DependsOn: deps}
}

func runPlan(t *testing.T, fn func(ctx context.Context, in Input) (Output, error), o Options, tasks ...plan.Task) RunStatus {
	t.Helper()
	m := NewManager(Config{Agents: []Agent{funcAgent{"t", fn}}, Options: fast(o)})
	st, err := m.SubmitPlan(context.Background(), plan.Plan{Goal: "g", Tasks: tasks}, Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	r, _ := m.Run(st.ID)
	return wait(t, r)
}

func wait(t *testing.T, r *Run) RunStatus {
	t.Helper()
	select {
	case <-r.Done():
	case <-time.After(5 * time.Second):
		t.Fatalf("run did not finish: %+v", r.Snapshot())
	}
	return r.Snapshot()
}

func states(st RunStatus) map[string]TaskState {
	out := map[string]TaskState{}
	for _, ts := range st.Tasks {
		out[ts.ID] = ts.State
	}
	return out
}

func TestDAGOrderAndDependencyOutputs(t *testing.T) {
	var mu sync.Mutex
	var order []string
	st := runPlan(t, func(ctx context.Context, in Input) (Output, error) {
		mu.Lock()
		order = append(order, in.Task.ID)
		mu.Unlock()
		var deps []string
		for _, d := range in.Deps {
			deps = append(deps, d.ID+"="+d.Output)
		}
		return Output{Text: in.Task.ID + "(" + strings.Join(deps, ",") + ")", Tokens: 10}, nil
	}, Options{}, task("a", plan.CostLow), task("b", plan.CostLow, "a"), task("c", plan.CostLow, "b", "a"))
	if st.State != RunSucceeded {
		t.Fatalf("state %s", st.State)
	}
	if strings.Join(order, "") != "abc" {
		t.Fatalf("order %v", order)
	}
	if st.Output != "c(b=b(a=a()),a=a())" || st.TokensUsed != 30 {
		t.Fatalf("output %q tokens %d", st.Output, st.TokensUsed)
	}
}

func TestMaxParallelDefaultsToTwo(t *testing.T) {
	var cur, peak int32
	st := runPlan(t, func(ctx context.Context, in Input) (Output, error) {
		n := atomic.AddInt32(&cur, 1)
		for {
			p := atomic.LoadInt32(&peak)
			if n <= p || atomic.CompareAndSwapInt32(&peak, p, n) {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
		atomic.AddInt32(&cur, -1)
		return Output{Text: "ok"}, nil
	}, Options{}, task("a", plan.CostLow), task("b", plan.CostLow), task("c", plan.CostLow), task("d", plan.CostLow))
	if st.State != RunSucceeded || peak != 2 || st.MaxParallel != 2 {
		t.Fatalf("state %s peak %d max %d", st.State, peak, st.MaxParallel)
	}
}

func TestFailureBlocksDependentsOnly(t *testing.T) {
	st := runPlan(t, func(ctx context.Context, in Input) (Output, error) {
		if in.Task.ID == "a" {
			return Output{}, Permanent(errors.New("bad input"))
		}
		return Output{Text: "ok"}, nil
	}, Options{}, task("a", plan.CostLow), task("b", plan.CostLow, "a"), task("c", plan.CostLow, "b"), task("x", plan.CostLow))
	s := states(st)
	if st.State != RunFailed || s["a"] != TaskFailed || s["b"] != TaskBlocked || s["c"] != TaskBlocked || s["x"] != TaskSucceeded {
		t.Fatalf("states %v run %s", s, st.State)
	}
	if st.Tasks[0].Attempts != 1 || !strings.Contains(st.Tasks[1].Reason, "depends on a, which is FAILED") {
		t.Fatalf("tasks %+v", st.Tasks)
	}
}

func TestBudgetSkipsAndShortCircuitsDependents(t *testing.T) {
	// Agent reports no usage, so each low task is charged its 2000 estimate.
	var ran int32
	st := runPlan(t, func(ctx context.Context, in Input) (Output, error) {
		atomic.AddInt32(&ran, 1)
		return Output{Text: "ok"}, nil
	}, Options{MaxTokens: 3000, MaxParallel: 1}, task("a", plan.CostLow), task("b", plan.CostLow), task("c", plan.CostLow, "b"))
	s := states(st)
	if st.State != RunSucceeded || s["a"] != TaskSucceeded || s["b"] != TaskSkipped || s["c"] != TaskSkipped || ran != 1 {
		t.Fatalf("states %v run %s ran %d", s, st.State, ran)
	}
	if !strings.Contains(st.Tasks[1].Reason, "token budget") || !strings.Contains(st.Tasks[2].Reason, "skipped") {
		t.Fatalf("reasons %+v", st.Tasks)
	}
	if st.TokensUsed != 2000 || st.TokenBudget != 3000 {
		t.Fatalf("tokens %d/%d", st.TokensUsed, st.TokenBudget)
	}
}

func TestTokenAwareSequencing(t *testing.T) {
	// Budget 9000: low (2000 reserved) + med (8000) don't fit together, so med
	// waits for low; low reports 500 real tokens, which frees room for med.
	var lowDone atomic.Bool
	var medSawLowDone atomic.Bool
	st := runPlan(t, func(ctx context.Context, in Input) (Output, error) {
		if in.Task.ID == "low" {
			time.Sleep(20 * time.Millisecond)
			lowDone.Store(true)
			return Output{Text: "l", Tokens: 500}, nil
		}
		medSawLowDone.Store(lowDone.Load())
		return Output{Text: "m", Tokens: 1000}, nil
	}, Options{MaxTokens: 9000}, task("med", plan.CostMed), task("low", plan.CostLow))
	if st.State != RunSucceeded || !medSawLowDone.Load() || st.TokensUsed != 1500 {
		t.Fatalf("state %s sequenced %v tokens %d", st.State, medSawLowDone.Load(), st.TokensUsed)
	}
}

func TestRetriesWithBackoff(t *testing.T) {
	var calls int32
	st := runPlan(t, func(ctx context.Context, in Input) (Output, error) {
		if atomic.AddInt32(&calls, 1) < 3 {
			return Output{}, errors.New("flaky")
		}
		return Output{Text: "ok"}, nil
	}, Options{}, task("a", plan.CostLow))
	if st.State != RunSucceeded || st.Tasks[0].Attempts != 3 || st.Tasks[0].Error != "" {
		t.Fatalf("%+v", st.Tasks[0])
	}

	st = runPlan(t, func(ctx context.Context, in Input) (Output, error) {
		return Output{}, errors.New("always")
	}, Options{MaxAttempts: 2}, task("a", plan.CostLow))
	if st.State != RunFailed || st.Tasks[0].Attempts != 2 || st.Tasks[0].Error != "always" {
		t.Fatalf("%+v", st.Tasks[0])
	}
}

func TestBackoffGrowsAndCaps(t *testing.T) {
	o := Options{BackoffBase: 100 * time.Millisecond, BackoffMax: 300 * time.Millisecond}.WithDefaults()
	if o.backoff(1) != 100*time.Millisecond || o.backoff(2) != 200*time.Millisecond || o.backoff(5) != 300*time.Millisecond {
		t.Fatal(o.backoff(1), o.backoff(2), o.backoff(5))
	}
}

func TestPanickingAgentFails(t *testing.T) {
	st := runPlan(t, func(ctx context.Context, in Input) (Output, error) { panic("oops") }, Options{}, task("a", plan.CostLow))
	if st.State != RunFailed || st.Tasks[0].Attempts != 1 || !strings.Contains(st.Tasks[0].Error, "panicked") {
		t.Fatalf("%+v", st.Tasks[0])
	}
}

func TestShortCircuitSkipsUnstartedTasks(t *testing.T) {
	st := runPlan(t, func(ctx context.Context, in Input) (Output, error) {
		return Output{Text: "found it", ShortCircuit: in.Task.ID == "quick"}, nil
	}, Options{MaxParallel: 1}, task("deep", plan.CostHigh), task("quick", plan.CostLow), task("after", plan.CostLow, "quick"))
	s := states(st)
	if st.State != RunSucceeded || s["quick"] != TaskSucceeded || s["deep"] != TaskSkipped || s["after"] != TaskSkipped {
		t.Fatalf("states %v", s)
	}
	if !strings.Contains(st.Tasks[0].Reason, "short-circuited") {
		t.Fatalf("reason %q", st.Tasks[0].Reason)
	}
}

func TestCancelStopsRunningAndPending(t *testing.T) {
	started := make(chan struct{})
	m := NewManager(Config{Agents: []Agent{funcAgent{"t", func(ctx context.Context, in Input) (Output, error) {
		close(started)
		<-ctx.Done()
		return Output{}, ctx.Err()
	}}}})
	st, err := m.SubmitPlan(context.Background(), plan.Plan{Tasks: []plan.Task{task("a", plan.CostLow), task("b", plan.CostLow, "a")}}, Overrides{})
	if err != nil {
		t.Fatal(err)
	}
	<-started
	if _, found, cancelled := m.Cancel(st.ID); !found || !cancelled {
		t.Fatal("cancel failed")
	}
	r, _ := m.Run(st.ID)
	final := wait(t, r)
	s := states(final)
	if final.State != RunCancelled || s["a"] != TaskCancelled || s["b"] != TaskCancelled {
		t.Fatalf("states %v run %s", s, final.State)
	}
	if _, _, again := m.Cancel(st.ID); again {
		t.Fatal("cancelling a finished run should report false")
	}
}

func TestCancelDuringBackoff(t *testing.T) {
	failed := make(chan struct{}, 1)
	m := NewManager(Config{Agents: []Agent{funcAgent{"t", func(ctx context.Context, in Input) (Output, error) {
		failed <- struct{}{}
		return Output{}, errors.New("flaky")
	}}}, Options: Options{BackoffBase: time.Hour, BackoffMax: time.Hour}})
	st, _ := m.SubmitPlan(context.Background(), plan.Plan{Tasks: []plan.Task{task("a", plan.CostLow)}}, Overrides{})
	<-failed
	m.Cancel(st.ID)
	r, _ := m.Run(st.ID)
	if final := wait(t, r); final.State != RunCancelled || final.Tasks[0].State != TaskCancelled {
		t.Fatalf("%+v", final)
	}
}

func TestSubmitPlanValidates(t *testing.T) {
	m := NewManager(Config{Agents: []Agent{funcAgent{"t", nil}}})
	_, err := m.SubmitPlan(context.Background(), plan.Plan{Tasks: []plan.Task{{ID: "a", Agent: "ghost", Input: "x", CostHint: "low"}}}, Overrides{})
	var ve *plan.ValidationError
	if !errors.As(err, &ve) || len(m.List()) != 0 {
		t.Fatalf("want validation error and no run, got %v", err)
	}
}

func TestSubmitTaskPlansThenRuns(t *testing.T) {
	reply := `{"goal":"g","tasks":[{"id":"a","agent":"t","input":"x","cost_hint":"low"}]}`
	agents := []Agent{funcAgent{"t", func(ctx context.Context, in Input) (Output, error) { return Output{Text: "done"}, nil }}}
	planner := &plan.Planner{LLM: &llm.Mock{Replies: []llm.MockReply{{Text: reply, Tokens: 42}}}, Agents: []plan.AgentSpec{agents[0].Spec()}}
	m := NewManager(Config{Agents: agents, Planner: planner})
	st, err := m.SubmitTask("do the thing", Overrides{MaxParallel: 99})
	if err != nil {
		t.Fatal(err)
	}
	r, _ := m.Run(st.ID)
	final := wait(t, r)
	if final.State != RunSucceeded || final.Output != "done" || final.PlannerTokens != 42 || final.Task != "do the thing" || final.MaxParallel != MaxParallelLimit {
		t.Fatalf("%+v", final)
	}

	bad := &plan.Planner{LLM: &llm.Mock{Replies: []llm.MockReply{{Text: "nope"}}}, Agents: planner.Agents}
	m = NewManager(Config{Agents: agents, Planner: bad})
	st, _ = m.SubmitTask("x", Overrides{})
	r, _ = m.Run(st.ID)
	if final := wait(t, r); final.State != RunFailed || !strings.Contains(final.Error, "planning failed") {
		t.Fatalf("%+v", final)
	}
}

func TestShutdownCancelsRuns(t *testing.T) {
	started := make(chan struct{})
	m := NewManager(Config{Agents: []Agent{funcAgent{"t", func(ctx context.Context, in Input) (Output, error) {
		close(started)
		<-ctx.Done()
		return Output{}, ctx.Err()
	}}}})
	st, _ := m.SubmitPlan(context.Background(), plan.Plan{Tasks: []plan.Task{task("a", plan.CostLow)}}, Overrides{})
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := m.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	r, _ := m.Run(st.ID)
	if r.Snapshot().State != RunCancelled {
		t.Fatal("run not cancelled")
	}
	if _, err := m.SubmitPlan(context.Background(), plan.Plan{Tasks: []plan.Task{task("a", plan.CostLow)}}, Overrides{}); !errors.Is(err, ErrShuttingDown) {
		t.Fatalf("got %v", err)
	}
}
