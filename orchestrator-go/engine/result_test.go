package engine

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"boop-agent/orchestrator/plan"
)

type fakeMerger struct {
	mu    sync.Mutex
	calls []MergeInput
	fn    func(ctx context.Context, in MergeInput) (MergeOutput, error)
}

func (f *fakeMerger) Merge(ctx context.Context, in MergeInput) (MergeOutput, error) {
	f.mu.Lock()
	f.calls = append(f.calls, in)
	f.mu.Unlock()
	return f.fn(ctx, in)
}

func runMerged(t *testing.T, merger Merger, o Options, fn func(ctx context.Context, in Input) (Output, error), tasks ...plan.Task) RunStatus {
	t.Helper()
	m := NewManager(Config{Agents: []Agent{funcAgent{"t", fn}}, Options: fast(o), Merger: merger})
	st, err := m.SubmitPlan(context.Background(), plan.Plan{Goal: "find the answer", Tasks: tasks}, Overrides{ConversationID: "conv_1"})
	if err != nil {
		t.Fatal(err)
	}
	r, _ := m.Run(st.ID)
	return wait(t, r)
}

func TestExtractURLs(t *testing.T) {
	got := ExtractURLs(
		"See https://example.com/a?b=1&c=2. And [doc](https://docs.example.com/x_(y)) here,",
		"dup https://example.com/a?b=1&c=2 and http://foo.test/path), plus https://",
	)
	want := []string{"https://example.com/a?b=1&c=2", "https://docs.example.com/x_(y)", "http://foo.test/path"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q", got)
	}
}

func TestEnsureSourcesAppendsOnlyMissing(t *testing.T) {
	out := EnsureSources("Answer citing https://a.test/1", []string{"https://a.test/1", "https://b.test/2"})
	if !strings.HasSuffix(out, "Sources:\n- https://b.test/2") || strings.Count(out, "https://a.test/1") != 1 {
		t.Fatalf("%q", out)
	}
	if EnsureSources("x", nil) != "x" {
		t.Fatal("no sources should leave the answer alone")
	}
}

func TestMergerCombinesAllStepsAndKeepsSources(t *testing.T) {
	merger := &fakeMerger{fn: func(ctx context.Context, in MergeInput) (MergeOutput, error) {
		// A sloppy merge that drops one URL: it must come back.
		return MergeOutput{Text: "Merged: see https://one.test/a", Tokens: 300}, nil
	}}
	st := runMerged(t, merger, Options{MaxTokens: 50_000}, func(ctx context.Context, in Input) (Output, error) {
		if in.ConversationID != "conv_1" {
			t.Errorf("conversation id not passed to agent: %q", in.ConversationID)
		}
		switch in.Task.ID {
		case "a":
			return Output{Text: "A found https://one.test/a", Tokens: 100}, nil
		case "b":
			return Output{Text: "B found https://two.test/b.", Tokens: 100}, nil
		}
		return Output{Text: "summary of a and b", Tokens: 100}, nil
	}, task("a", plan.CostLow), task("b", plan.CostLow), task("c", plan.CostLow, "a", "b"))

	if st.State != RunSucceeded || st.Result == nil || st.Result.Method != MergeLLM {
		t.Fatalf("%+v %+v", st, st.Result)
	}
	if st.ConversationID != "conv_1" {
		t.Fatalf("conversation id %q", st.ConversationID)
	}
	if !strings.Contains(st.Output, "https://one.test/a") || !strings.Contains(st.Output, "https://two.test/b") || st.Output != st.Result.Answer {
		t.Fatalf("sources lost: %q", st.Output)
	}
	if st.TokensUsed != 300+300 || st.Result.Tokens != 300 {
		t.Fatalf("tokens used %d, merge %d", st.TokensUsed, st.Result.Tokens)
	}
	in := merger.calls[0]
	if len(in.Steps) != 3 || in.Steps[0].Final || !in.Steps[2].Final || in.Request != "find the answer" {
		t.Fatalf("merge input %+v", in)
	}
	if in.Budget != 50_000-300 {
		t.Fatalf("merge budget %d", in.Budget)
	}
	if !reflect.DeepEqual(in.Sources, []string{"https://one.test/a", "https://two.test/b"}) {
		t.Fatalf("sources %q", in.Sources)
	}
}

func TestMergerSeesFailedAndSkippedSteps(t *testing.T) {
	merger := &fakeMerger{fn: func(ctx context.Context, in MergeInput) (MergeOutput, error) {
		return MergeOutput{Text: "partial answer", Tokens: 10}, nil
	}}
	st := runMerged(t, merger, Options{MaxAttempts: 1}, func(ctx context.Context, in Input) (Output, error) {
		if in.Task.ID == "bad" {
			return Output{}, Permanent(errors.New("mailbox unreachable"))
		}
		return Output{Text: "ok " + in.Task.ID}, nil
	}, task("good", plan.CostLow), task("bad", plan.CostLow), task("after", plan.CostLow, "bad"))

	if st.State != RunFailed || st.Result.Method != MergeLLM || st.Output != "partial answer" {
		t.Fatalf("%s %+v", st.State, st.Result)
	}
	if len(st.Result.Incomplete) != 2 || st.Result.Incomplete[0].ID != "bad" || st.Result.Incomplete[0].Note != "mailbox unreachable" ||
		st.Result.Incomplete[1].State != TaskBlocked {
		t.Fatalf("incomplete %+v", st.Result.Incomplete)
	}
	states := map[string]TaskState{}
	for _, s := range merger.calls[0].Steps {
		states[s.ID] = s.State
	}
	if states["bad"] != TaskFailed || states["after"] != TaskBlocked {
		t.Fatalf("merger saw %v", states)
	}
}

func TestMergeFallsBackWhenBudgetIsSpent(t *testing.T) {
	merger := &fakeMerger{fn: func(ctx context.Context, in MergeInput) (MergeOutput, error) {
		t.Error("merger should not be called without budget")
		return MergeOutput{}, nil
	}}
	// Two low tasks (2k each) charged their estimate leave 1k of 5k: not enough to merge.
	st := runMerged(t, merger, Options{MaxTokens: 5_000}, func(ctx context.Context, in Input) (Output, error) {
		return Output{Text: in.Task.ID + " at https://x.test/" + in.Task.ID}, nil
	}, task("a", plan.CostLow), task("b", plan.CostLow))
	if st.Result.Method != MergeFallback || !strings.Contains(st.Result.MergeError, "token budget") {
		t.Fatalf("%+v", st.Result)
	}
	if !strings.Contains(st.Output, "## a\na at https://x.test/a") || !strings.Contains(st.Output, "https://x.test/b") {
		t.Fatalf("fallback output %q", st.Output)
	}
	if st.TokensUsed > 5_000 {
		t.Fatalf("over budget: %d", st.TokensUsed)
	}
}

func TestMergeFailureFallsBackAndChargesTokens(t *testing.T) {
	merger := &fakeMerger{fn: func(ctx context.Context, in MergeInput) (MergeOutput, error) {
		return MergeOutput{Tokens: 42}, errors.New("overloaded")
	}}
	st := runMerged(t, merger, Options{}, func(ctx context.Context, in Input) (Output, error) {
		return Output{Text: "out " + in.Task.ID, Tokens: 1}, nil
	}, task("a", plan.CostLow), task("b", plan.CostLow, "a"))
	if st.State != RunSucceeded || st.Result.Method != MergeFallback || st.Output != "out b" ||
		!strings.Contains(st.Result.MergeError, "overloaded") || st.TokensUsed != 44 {
		t.Fatalf("%+v %+v", st, st.Result)
	}
}

func TestSingleStepAndNoOutputSkipTheMerger(t *testing.T) {
	merger := &fakeMerger{fn: func(ctx context.Context, in MergeInput) (MergeOutput, error) {
		t.Error("merger should not be called")
		return MergeOutput{}, nil
	}}
	st := runMerged(t, merger, Options{}, func(ctx context.Context, in Input) (Output, error) {
		return Output{Text: "only"}, nil
	}, task("a", plan.CostLow))
	if st.Result.Method != MergeSingle || st.Output != "only" {
		t.Fatalf("%+v", st.Result)
	}
	st = runMerged(t, merger, Options{MaxAttempts: 1}, func(ctx context.Context, in Input) (Output, error) {
		return Output{}, Permanent(errors.New("nope"))
	}, task("a", plan.CostLow), task("b", plan.CostLow))
	if st.State != RunFailed || st.Result.Method != MergeNone || !strings.Contains(st.Output, "Not completed:") {
		t.Fatalf("%+v", st.Result)
	}
}

func TestCancelDuringMerge(t *testing.T) {
	entered := make(chan struct{})
	merger := &fakeMerger{fn: func(ctx context.Context, in MergeInput) (MergeOutput, error) {
		close(entered)
		<-ctx.Done()
		return MergeOutput{}, ctx.Err()
	}}
	m := NewManager(Config{Agents: []Agent{funcAgent{"t", func(ctx context.Context, in Input) (Output, error) {
		return Output{Text: "x " + in.Task.ID}, nil
	}}}, Merger: merger})
	st, _ := m.SubmitPlan(context.Background(), plan.Plan{Tasks: []plan.Task{task("a", plan.CostLow), task("b", plan.CostLow)}}, Overrides{})
	r, _ := m.Run(st.ID)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("merger never called")
	}
	if s := r.Snapshot().State; s != RunMerging {
		t.Fatalf("state during merge %s", s)
	}
	if _, _, ok := m.Cancel(st.ID); !ok {
		t.Fatal("cancel during merge refused")
	}
	final := wait(t, r)
	if final.State != RunCancelled || final.Result.Method != MergeFallback || !strings.Contains(final.Output, "x a") {
		t.Fatalf("%+v %+v", final, final.Result)
	}
}
