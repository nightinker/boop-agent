// Package agents holds the orchestrator's agents: Go-native ones (echo, join,
// llm) and Boop, a bridge to Boop's TypeScript sub-agents.
package agents

import (
	"context"
	"fmt"
	"strings"

	"boop-agent/orchestrator/engine"
	"boop-agent/orchestrator/llm"
	"boop-agent/orchestrator/plan"
)

// MaxDepChars caps how much of each upstream output is passed to an agent.
const MaxDepChars = 6000

// Echo returns its input. Useful for testing plans end to end.
type Echo struct{}

func (Echo) Spec() plan.AgentSpec {
	return plan.AgentSpec{Name: "echo", Description: "Returns its input unchanged. Only for testing."}
}

func (Echo) Run(ctx context.Context, in engine.Input) (engine.Output, error) {
	return engine.Output{Text: in.Task.Input, Tokens: 1}, ctx.Err()
}

// Join concatenates the outputs of the tasks it depends on, without a model.
type Join struct{}

func (Join) Spec() plan.AgentSpec {
	return plan.AgentSpec{Name: "join", Description: "Combines the outputs of the tasks it depends on into one document, verbatim, with a heading per task. No model call, near-zero cost; use when results just need collecting."}
}

func (Join) Run(ctx context.Context, in engine.Input) (engine.Output, error) {
	if len(in.Deps) == 0 {
		return engine.Output{}, engine.Permanent(fmt.Errorf("join needs depends_on"))
	}
	var b strings.Builder
	for i, d := range in.Deps {
		if i > 0 {
			b.WriteString("\n\n")
		}
		fmt.Fprintf(&b, "## %s\n%s", depTitle(d), d.Output)
	}
	return engine.Output{Text: b.String(), Tokens: 1}, ctx.Err()
}

// LLM answers a task with the model alone (no tools): reasoning, summarising,
// drafting or deciding over the outputs of earlier tasks.
type LLM struct {
	Provider  llm.LLMProvider
	MaxTokens int // 0 means 4000
}

func (LLM) Spec() plan.AgentSpec {
	return plan.AgentSpec{Name: "llm", Description: "A language model with no tools: summarises, compares, drafts or decides using only the task text and earlier tasks' outputs. Cannot look anything up."}
}

const llmSystem = `You are one step in a larger plan run by a personal assistant. Do exactly the step you're given, using the context from earlier steps. Reply with the result only, no preamble. If the context is missing what you need, say what's missing.`

func (a LLM) Run(ctx context.Context, in engine.Input) (engine.Output, error) {
	if a.Provider == nil {
		return engine.Output{}, engine.Permanent(fmt.Errorf("llm agent has no provider"))
	}
	maxTokens := a.MaxTokens
	if maxTokens == 0 {
		maxTokens = 4000
	}
	res, err := a.Provider.Complete(ctx, llm.Request{
		System:    llmSystem,
		Messages:  []llm.Message{{Role: "user", Content: TaskText(in)}},
		MaxTokens: maxTokens,
	})
	if err != nil {
		return engine.Output{Tokens: res.TotalTokens()}, classifyLLMError(err)
	}
	return engine.Output{Text: strings.TrimSpace(res.Text), Tokens: res.TotalTokens()}, nil
}

func classifyLLMError(err error) error {
	if se, ok := err.(*llm.StatusError); ok && !se.Retryable() {
		return engine.Permanent(err)
	}
	if err == llm.ErrRefused {
		return engine.Permanent(err)
	}
	return err
}

// TaskText renders a task for an agent: the instruction, the scout hints and
// the (truncated) outputs of earlier tasks.
func TaskText(in engine.Input) string {
	var b strings.Builder
	b.WriteString(in.Task.Input)
	if in.Task.Scout != nil && len(in.Task.Scout.Narrow) > 0 {
		b.WriteString("\n\nStart narrow — check these first and widen only if they come up empty:\n")
		for _, h := range in.Task.Scout.Narrow {
			fmt.Fprintf(&b, "- %s\n", h)
		}
	}
	if len(in.Deps) > 0 {
		b.WriteString("\n\nResults from earlier steps:\n")
		for _, d := range in.Deps {
			out := d.Output
			if len(out) > MaxDepChars {
				out = out[:MaxDepChars] + "\n…(truncated)"
			}
			fmt.Fprintf(&b, "\n### %s\n%s\n", depTitle(d), out)
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

func depTitle(d engine.DepOutput) string {
	if d.Title != "" {
		return d.Title
	}
	return d.ID
}
