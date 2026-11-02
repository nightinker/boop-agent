package merge

import (
	"context"
	"errors"
	"strings"
	"testing"

	"boop-agent/orchestrator/engine"
	"boop-agent/orchestrator/llm"
	"boop-agent/orchestrator/plan"
)

func mergeInput(budget int, outputLen int) engine.MergeInput {
	long := strings.Repeat("detail ", outputLen/7) + " https://late.test/end"
	return engine.MergeInput{
		Request: "What did the two sites say?",
		Plan:    plan.Plan{Goal: "Compare two sites"},
		Steps: []engine.MergeStep{
			{TaskStatus: engine.TaskStatus{ID: "a", Title: "Site A", State: engine.TaskSucceeded, Output: "A says yes https://a.test/1"}},
			{TaskStatus: engine.TaskStatus{ID: "b", Title: "Site B", State: engine.TaskSucceeded, Output: long}},
			{TaskStatus: engine.TaskStatus{ID: "c", State: engine.TaskFailed, Error: "timeout"}},
			{TaskStatus: engine.TaskStatus{ID: "d", State: engine.TaskSkipped, Reason: "token budget"}, Final: true},
		},
		Sources: []string{"https://a.test/1", "https://late.test/end"},
		Budget:  budget,
	}
}

func TestPromptHasStepsFailuresAndSources(t *testing.T) {
	p := Prompt(mergeInput(0, 100), MaxStepChars)
	for _, want := range []string{
		"What did the two sites say?", "Plan goal: Compare two sites",
		"### Site A (succeeded)", "A says yes https://a.test/1",
		"### c (failed)\nDid not complete: timeout", "### d (skipped, final step)\nDid not complete: token budget",
		"- https://a.test/1", "- https://late.test/end",
	} {
		if !strings.Contains(p, want) {
			t.Errorf("prompt is missing %q:\n%s", want, p)
		}
	}
}

func TestMergeUsesModelAndReportsTokens(t *testing.T) {
	mock := &llm.Mock{Replies: []llm.MockReply{{Text: "  The answer.  ", Tokens: 120}}}
	out, err := LLM{Provider: mock}.Merge(context.Background(), mergeInput(0, 100))
	if err != nil || out.Text != "The answer." || out.Tokens != 120 {
		t.Fatalf("%+v %v", out, err)
	}
	req := mock.Calls()[0]
	if req.MaxTokens != DefaultMaxOutput || !strings.Contains(req.System, "character for character") {
		t.Fatalf("request %+v", req)
	}
}

func TestMergeFitsTheBudget(t *testing.T) {
	mock := &llm.Mock{Replies: []llm.MockReply{{Text: "ok"}}}
	in := mergeInput(8_000, 200_000) // a step far bigger than the budget
	if _, err := (LLM{Provider: mock}).Merge(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	req := mock.Calls()[0]
	if req.MaxTokens != 2_000 {
		t.Fatalf("max output %d, want a quarter of the budget", req.MaxTokens)
	}
	promptTokens := (len(req.System) + len(req.Messages[0].Content)) / 4
	if promptTokens+req.MaxTokens > in.Budget {
		t.Fatalf("prompt ~%d + output %d tokens exceeds budget %d", promptTokens, req.MaxTokens, in.Budget)
	}
	content := req.Messages[0].Content
	if !strings.Contains(content, "…(truncated)") || !strings.Contains(content, "- https://late.test/end") {
		t.Fatal("long step should be cut, with its URL still listed in full")
	}
}

func TestMergeRefusesATinyBudget(t *testing.T) {
	mock := &llm.Mock{Replies: []llm.MockReply{{Text: "ok"}}}
	_, err := LLM{Provider: mock}.Merge(context.Background(), mergeInput(1_000, 100))
	if !errors.Is(err, engine.ErrMergeBudget) || len(mock.Calls()) != 0 {
		t.Fatalf("err %v calls %d", err, len(mock.Calls()))
	}
}

func TestMergeErrorsAndCutShortAnswers(t *testing.T) {
	_, err := LLM{Provider: &llm.Mock{Replies: []llm.MockReply{{Err: errors.New("boom")}}}}.Merge(context.Background(), mergeInput(0, 10))
	if err == nil {
		t.Fatal("want error")
	}
	cutShort := &llm.Mock{Fn: func(ctx context.Context, req llm.Request) (llm.Response, error) {
		return llm.Response{Text: "half", OutputTokens: 5, StopReason: "max_tokens"}, nil
	}}
	out, _ := LLM{Provider: cutShort}.Merge(context.Background(), mergeInput(0, 10))
	if !strings.Contains(out.Text, "cut short") {
		t.Fatalf("%q", out.Text)
	}
	if _, err := (LLM{}).Merge(context.Background(), mergeInput(0, 10)); err == nil {
		t.Fatal("no provider should fail")
	}
}

func TestCutKeepsUTF8Whole(t *testing.T) {
	if got := cut("héllo", 2); got != "h" {
		t.Fatalf("%q", got)
	}
}
