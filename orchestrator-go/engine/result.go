package engine

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"boop-agent/orchestrator/plan"
)

// How a run's final answer was put together (RunResult.Method).
const (
	// MergeLLM: a Merger (the report agent) combined the step outputs.
	MergeLLM = "llm"
	// MergeSingle: the plan had one step; its output is the answer as-is.
	MergeSingle = "single"
	// MergeFallback: the outputs of the final steps, joined without a model
	// (no merger configured, not enough budget, the merger failed, or the run
	// was cancelled).
	MergeFallback = "fallback"
	// MergeNone: no step produced any output.
	MergeNone = "none"
)

// RunResult is a finished run's final answer.
type RunResult struct {
	Answer string `json:"answer"`
	Method string `json:"method"`
	// Sources are every URL found in the step outputs, in first-seen order.
	// Each one also appears verbatim in Answer.
	Sources []string `json:"sources,omitempty"`
	// Incomplete lists the steps that didn't succeed, and why.
	Incomplete []StepNote `json:"incomplete,omitempty"`
	// Tokens the merge itself used (already counted in RunStatus.TokensUsed).
	Tokens int `json:"tokens,omitempty"`
	// MergeError says why the merger wasn't used or didn't work, when Method is "fallback".
	MergeError string `json:"merge_error,omitempty"`
}

// StepNote is a step that didn't succeed.
type StepNote struct {
	ID    string    `json:"id"`
	Title string    `json:"title,omitempty"`
	State TaskState `json:"state"`
	Note  string    `json:"note,omitempty"`
}

// MergeInput is everything a Merger gets.
type MergeInput struct {
	RunID string
	// Request is what the user asked: the submitted task, or the plan's goal.
	Request string
	Plan    plan.Plan
	// Steps are every step's final status, in plan order. Final marks the
	// steps nothing else depends on.
	Steps []MergeStep
	// Sources are the URLs found in the succeeded steps' full outputs.
	Sources []string
	// Budget is how many tokens the merge may use; 0 means unlimited.
	Budget int
}

// MergeStep is one step as the merger sees it.
type MergeStep struct {
	TaskStatus
	Final bool
}

// MergeOutput is the merger's answer.
type MergeOutput struct {
	Text   string
	Tokens int
}

// Merger combines a finished run's step outputs into one final answer (the
// report agent). It must keep within in.Budget.
type Merger interface {
	Merge(ctx context.Context, in MergeInput) (MergeOutput, error)
}

// MinMergeBudget is the least budget the merger is called with. With fewer
// tokens left the fallback answer is used instead.
const MinMergeBudget = 2_000

// ErrMergeBudget is returned by a Merger that can't fit in its budget.
var ErrMergeBudget = errors.New("not enough token budget left to merge")

var urlRe = regexp.MustCompile(`https?://[^\s<>"'\x60\[\]{}|\\^]+`)

// ExtractURLs returns the URLs in text, deduplicated, in first-seen order.
// Trailing punctuation and an unbalanced closing parenthesis (as in a
// Markdown link) aren't part of the URL.
func ExtractURLs(texts ...string) []string {
	seen := map[string]bool{}
	var out []string
	for _, text := range texts {
		for _, u := range urlRe.FindAllString(text, -1) {
			u = trimURL(u)
			if len(u) <= len("https://") || seen[u] {
				continue
			}
			seen[u] = true
			out = append(out, u)
		}
	}
	return out
}

func trimURL(u string) string {
	for {
		n := len(u)
		u = strings.TrimRight(u, ".,;:!?*_~")
		if strings.HasSuffix(u, ")") && strings.Count(u, "(") < strings.Count(u, ")") {
			u = u[:len(u)-1]
		}
		if len(u) == n {
			return u
		}
	}
}

// EnsureSources appends any of sources missing from answer under a
// "Sources" heading, so no URL a step found is lost or rewritten.
func EnsureSources(answer string, sources []string) string {
	var missing []string
	for _, s := range sources {
		if !strings.Contains(answer, s) {
			missing = append(missing, s)
		}
	}
	if len(missing) == 0 {
		return answer
	}
	var b strings.Builder
	b.WriteString(strings.TrimRight(answer, "\n"))
	if b.Len() > 0 {
		b.WriteString("\n\n")
	}
	b.WriteString("Sources:\n")
	for _, s := range missing {
		fmt.Fprintf(&b, "- %s\n", s)
	}
	return strings.TrimRight(b.String(), "\n")
}

func taskLabel(ts TaskStatus) string {
	if ts.Title != "" {
		return ts.Title
	}
	return ts.ID
}

// incomplete lists the steps that didn't succeed.
func incomplete(tasks []TaskStatus) []StepNote {
	var out []StepNote
	for _, ts := range tasks {
		if ts.State == TaskSucceeded {
			continue
		}
		note := ts.Reason
		if ts.Error != "" {
			note = ts.Error
		}
		out = append(out, StepNote{ID: ts.ID, Title: ts.Title, State: ts.State, Note: note})
	}
	return out
}

// fallbackAnswer joins the final steps' outputs and says which steps didn't finish.
func fallbackAnswer(sinks string, notes []StepNote) string {
	if len(notes) == 0 {
		return sinks
	}
	var b strings.Builder
	b.WriteString(sinks)
	if b.Len() > 0 {
		b.WriteString("\n\n")
	}
	b.WriteString("Not completed:")
	for _, n := range notes {
		label := n.Title
		if label == "" {
			label = n.ID
		}
		fmt.Fprintf(&b, "\n- %s: %s", label, strings.ToLower(string(n.State)))
		if n.Note != "" {
			fmt.Fprintf(&b, " (%s)", n.Note)
		}
	}
	return b.String()
}

// finalize builds the run's result once every step has settled. It calls the
// merger when there's something worth merging and budget for it, and falls
// back to joining the final steps otherwise. It returns the result and the
// tokens the merge used.
func finalize(ctx context.Context, r *Run, p plan.Plan, state map[string]TaskState, outputs map[string]string,
	merger Merger, o Options, used int) RunResult {
	snap := r.Snapshot()
	notes := incomplete(snap.Tasks)

	var texts []string
	for _, t := range p.Tasks {
		if state[t.ID] == TaskSucceeded {
			texts = append(texts, outputs[t.ID])
		}
	}
	res := RunResult{Sources: ExtractURLs(texts...), Incomplete: notes}
	sinks := sinkOutput(p, state, outputs)

	succeeded := 0
	for _, t := range p.Tasks {
		if state[t.ID] == TaskSucceeded && strings.TrimSpace(outputs[t.ID]) != "" {
			succeeded++
		}
	}

	fallback := func(why string) RunResult {
		res.Method = MergeFallback
		res.MergeError = why
		res.Answer = EnsureSources(fallbackAnswer(sinks, notes), res.Sources)
		return res
	}

	switch {
	case succeeded == 0:
		res.Method = MergeNone
		res.Answer = fallbackAnswer("", notes)
		return res
	case ctx.Err() != nil:
		return fallback("run cancelled")
	case len(p.Tasks) == 1:
		res.Method = MergeSingle
		res.Answer = sinks
		return res
	case merger == nil:
		return fallback("")
	}

	budget := 0
	if o.MaxTokens > 0 {
		budget = o.MaxTokens - used
		if budget < MinMergeBudget {
			return fallback(fmt.Sprintf("token budget: %d left, merging needs at least %d", max(budget, 0), MinMergeBudget))
		}
	}

	dependents := p.Dependents()
	in := MergeInput{RunID: snap.ID, Request: snap.Task, Plan: p, Sources: res.Sources, Budget: budget}
	if in.Request == "" {
		in.Request = p.Goal
	}
	for _, ts := range snap.Tasks {
		in.Steps = append(in.Steps, MergeStep{TaskStatus: ts, Final: len(dependents[ts.ID]) == 0})
	}

	r.setState(RunMerging)
	out, err := safeMerge(ctx, merger, in)
	res.Tokens = out.Tokens
	if err != nil {
		f := fallback("merge failed: " + err.Error())
		f.Tokens = out.Tokens
		return f
	}
	if strings.TrimSpace(out.Text) == "" {
		f := fallback("merge returned an empty answer")
		f.Tokens = out.Tokens
		return f
	}
	res.Method = MergeLLM
	res.Answer = EnsureSources(strings.TrimSpace(out.Text), res.Sources)
	return res
}

func safeMerge(ctx context.Context, m Merger, in MergeInput) (out MergeOutput, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("merger panicked: %v", p)
		}
	}()
	return m.Merge(ctx, in)
}
