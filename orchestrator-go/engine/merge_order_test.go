package engine

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"boop-agent/orchestrator/plan"
)

// Steps finishing in a different order from the plan must not change what the
// merger sees or what the run returns.
func TestMergeIsInPlanOrderWhateverFinishesFirst(t *testing.T) {
	delays := map[string]time.Duration{"a": 30 * time.Millisecond, "b": 15 * time.Millisecond, "c": 0}
	fn := func(ctx context.Context, in Input) (Output, error) {
		time.Sleep(delays[in.Task.ID])
		if in.Task.ID == "b" {
			return Output{}, Permanent(errors.New("down"))
		}
		return Output{Text: in.Task.ID + " https://x.test/" + in.Task.ID}, nil
	}
	tasks := []plan.Task{task("a", plan.CostLow), task("b", plan.CostLow), task("c", plan.CostLow)}

	var first RunStatus
	for i := 0; i < 3; i++ {
		var seen []string
		merger := &fakeMerger{fn: func(ctx context.Context, in MergeInput) (MergeOutput, error) {
			for _, s := range in.Steps {
				seen = append(seen, s.ID)
			}
			return MergeOutput{}, errors.New("force fallback")
		}}
		st := runMerged(t, merger, Options{MaxAttempts: 1, MaxParallel: 3}, fn, tasks...)
		if !reflect.DeepEqual(seen, []string{"a", "b", "c"}) {
			t.Fatalf("merger saw steps %v", seen)
		}
		if !reflect.DeepEqual(st.Result.Sources, []string{"https://x.test/a", "https://x.test/c"}) {
			t.Fatalf("sources %v", st.Result.Sources)
		}
		if strings.Index(st.Output, "## a") > strings.Index(st.Output, "## c") {
			t.Fatalf("fallback out of order: %q", st.Output)
		}
		if i == 0 {
			first = st
		} else if st.Output != first.Output || !reflect.DeepEqual(st.Result.Incomplete, first.Result.Incomplete) {
			t.Fatalf("run %d differs:\n%q\n%q", i, st.Output, first.Output)
		}
	}
}

// A step that succeeds with no output isn't shown as an empty section, and a
// panicking merger falls back instead of crashing the run.
func TestFallbackSkipsEmptyStepsAndSurvivesMergerPanic(t *testing.T) {
	merger := &fakeMerger{fn: func(ctx context.Context, in MergeInput) (MergeOutput, error) {
		panic("boom")
	}}
	st := runMerged(t, merger, Options{}, func(ctx context.Context, in Input) (Output, error) {
		if in.Task.ID == "empty" {
			return Output{Text: "  \n"}, nil
		}
		return Output{Text: "found it"}, nil
	}, task("full", plan.CostLow), task("empty", plan.CostLow))
	if st.State != RunSucceeded || st.Result.Method != MergeFallback || !strings.Contains(st.Result.MergeError, "panicked") {
		t.Fatalf("%s %+v", st.State, st.Result)
	}
	if st.Output != "found it" {
		t.Fatalf("fallback output %q", st.Output)
	}
}

// If the final step succeeds with nothing to say, the fallback still returns
// what earlier steps found instead of an empty answer.
func TestFallbackUsesEarlierStepsWhenFinalStepIsEmpty(t *testing.T) {
	st := runMerged(t, nil, Options{}, func(ctx context.Context, in Input) (Output, error) {
		if in.Task.ID == "summary" {
			return Output{}, nil
		}
		return Output{Text: "raw " + in.Task.ID}, nil
	}, task("mail", plan.CostLow), task("summary", plan.CostLow, "mail"))
	if st.Result.Method != MergeFallback || st.Output != "raw mail" {
		t.Fatalf("%+v %q", st.Result, st.Output)
	}
}
