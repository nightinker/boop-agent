// Package merge is the report agent: once every step of a run has finished,
// it asks the model to combine the step outputs into one answer. URLs are
// kept verbatim, failed and skipped steps are named rather than hidden, and
// the call is sized to fit what's left of the run's token budget.
package merge

import (
	"context"
	"fmt"
	"strings"

	"boop-agent/orchestrator/engine"
	"boop-agent/orchestrator/llm"
)

const (
	// DefaultMaxOutput caps the answer's length in tokens.
	DefaultMaxOutput = 4_000
	// MinOutput is the smallest answer worth asking for.
	MinOutput = 500
	// MaxStepChars caps one step's output in the prompt when there's no budget limit.
	MaxStepChars = 24_000
	// charsPerToken is the rough estimate used to size the prompt.
	charsPerToken = 4
)

// LLM merges with a language model (Claude, via the Anthropic provider).
type LLM struct {
	Provider llm.LLMProvider
	// MaxOutput caps the answer in tokens; 0 means DefaultMaxOutput.
	MaxOutput int
}

const system = `You write the final answer for a task that a personal assistant split into steps and ran. Combine the step results into ONE coherent answer to the user's request, as if you had done the work yourself.

Rules:
- Use only what's in the step results. Don't add facts, numbers or links of your own.
- Copy every URL exactly as written, character for character, next to the fact it supports. Never shorten, rewrite or drop a URL.
- Merge overlapping results; don't repeat the same thing per step, and don't narrate the steps.
- If some steps failed or were skipped, answer with what you have, then say briefly what's missing and why. Don't present a partial answer as complete.
- If the results contradict each other, say so.
- Reply with the answer only: no preamble, no "Here is".`

// Merge implements engine.Merger.
func (m LLM) Merge(ctx context.Context, in engine.MergeInput) (engine.MergeOutput, error) {
	if m.Provider == nil {
		return engine.MergeOutput{}, fmt.Errorf("merge: no model provider")
	}
	maxOut := m.MaxOutput
	if maxOut <= 0 {
		maxOut = DefaultMaxOutput
	}
	stepChars := MaxStepChars
	if in.Budget > 0 {
		// Leave the answer about a quarter of what's left, then share the
		// rest between the prompt's fixed part and the step outputs.
		maxOut = min(maxOut, in.Budget/4)
		if maxOut < MinOutput {
			return engine.MergeOutput{}, engine.ErrMergeBudget
		}
		fixed := estimateTokens(system + Prompt(in, 0))
		room := in.Budget - maxOut - fixed
		withOutput := 0
		for _, s := range in.Steps {
			if s.State == engine.TaskSucceeded && s.Output != "" {
				withOutput++
			}
		}
		if withOutput > 0 {
			stepChars = min(stepChars, room*charsPerToken/withOutput)
		}
		if stepChars < 200 {
			return engine.MergeOutput{}, engine.ErrMergeBudget
		}
	}
	res, err := m.Provider.Complete(ctx, llm.Request{
		System:    system,
		Messages:  []llm.Message{{Role: "user", Content: Prompt(in, stepChars)}},
		MaxTokens: maxOut,
	})
	if err != nil {
		return engine.MergeOutput{Tokens: res.TotalTokens()}, err
	}
	text := strings.TrimSpace(res.Text)
	if res.StopReason == "max_tokens" && text != "" {
		text += "\n\n(The answer was cut short to stay within the token budget.)"
	}
	return engine.MergeOutput{Text: text, Tokens: res.TotalTokens()}, nil
}

// Prompt renders the merge request. Each step's output is cut to stepChars
// (0 leaves outputs out entirely, for sizing). Sources are listed in full
// whatever the cut, so URLs from a truncated output still reach the model.
func Prompt(in engine.MergeInput, stepChars int) string {
	var b strings.Builder
	fmt.Fprintf(&b, "User's request:\n%s\n", strings.TrimSpace(in.Request))
	if in.Plan.Goal != "" && in.Plan.Goal != in.Request {
		fmt.Fprintf(&b, "\nPlan goal: %s\n", in.Plan.Goal)
	}
	b.WriteString("\nStep results, in plan order:\n")
	for _, s := range in.Steps {
		label := s.Title
		if label == "" {
			label = s.ID
		}
		final := ""
		if s.Final {
			final = ", final step"
		}
		fmt.Fprintf(&b, "\n### %s (%s%s)\n", label, strings.ToLower(string(s.State)), final)
		switch s.State {
		case engine.TaskSucceeded:
			out := strings.TrimSpace(s.Output)
			if out == "" {
				b.WriteString("(no output)\n")
				continue
			}
			if stepChars == 0 {
				continue
			}
			if len(out) > stepChars {
				out = cut(out, stepChars) + "\n…(truncated)"
			}
			b.WriteString(out + "\n")
		default:
			why := s.Error
			if why == "" {
				why = s.Reason
			}
			if why == "" {
				why = "no details"
			}
			fmt.Fprintf(&b, "Did not complete: %s\n", why)
		}
	}
	if len(in.Sources) > 0 {
		b.WriteString("\nURLs found in the step results (keep each one exactly as written):\n")
		for _, u := range in.Sources {
			fmt.Fprintf(&b, "- %s\n", u)
		}
	}
	return strings.TrimRight(b.String(), "\n")
}

// cut shortens s to at most n bytes without splitting a UTF-8 character.
func cut(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && n < len(s) && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n]
}

func estimateTokens(s string) int { return len(s)/charsPerToken + 1 }
