package plan

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"boop-agent/orchestrator/llm"
)

// Planner asks an LLM to break a user task into a Plan, then validates it.
// If the answer doesn't parse or validate, the problems are sent back and the
// model gets another try, up to MaxAttempts.
type Planner struct {
	LLM    llm.LLMProvider
	Agents []AgentSpec
	// Integrations returns the integrations Boop's sub-agents can use. Optional;
	// when nil or failing, integration names aren't checked.
	Integrations func(ctx context.Context) ([]string, error)
	MaxTasks     int // 0 means DefaultMaxTasks
	MaxAttempts  int // 0 means 2
	MaxTokens    int // per planner call; 0 means 4000
}

// Result is a validated plan and what planning cost.
type Result struct {
	Plan     Plan `json:"plan"`
	Tokens   int  `json:"tokens"`
	Attempts int  `json:"attempts"`
}

// ErrEmptyTask is returned for a blank task.
var ErrEmptyTask = errors.New("task is empty")

// Plan turns task into a validated plan.
func (p *Planner) Plan(ctx context.Context, task string) (Result, error) {
	task = strings.TrimSpace(task)
	if task == "" {
		return Result{}, ErrEmptyTask
	}
	if p.LLM == nil {
		return Result{}, errors.New("planner has no LLM provider")
	}
	rules := Rules{Agents: p.Agents, MaxTasks: p.MaxTasks}
	if p.Integrations != nil {
		if list, err := p.Integrations(ctx); err == nil {
			rules.Integrations = list
			if rules.Integrations == nil {
				rules.Integrations = []string{}
			}
		}
	}
	attempts := p.MaxAttempts
	if attempts <= 0 {
		attempts = 2
	}
	maxTokens := p.MaxTokens
	if maxTokens <= 0 {
		maxTokens = 4000
	}
	system := p.systemPrompt(rules)
	messages := []llm.Message{{Role: "user", Content: "Task:\n" + task}}
	var res Result
	var lastErr error
	for res.Attempts < attempts {
		res.Attempts++
		reply, err := p.LLM.Complete(ctx, llm.Request{System: system, Messages: messages, MaxTokens: maxTokens})
		if err != nil {
			return res, fmt.Errorf("planner call failed: %w", err)
		}
		res.Tokens += reply.TotalTokens()
		plan, err := ParsePlan(reply.Text)
		if err == nil {
			if plan.Goal == "" {
				plan.Goal = task
			}
			err = Validate(plan, rules)
		}
		if err == nil {
			res.Plan = plan
			return res, nil
		}
		lastErr = err
		messages = append(messages,
			llm.Message{Role: "assistant", Content: reply.Text},
			llm.Message{Role: "user", Content: "That plan was rejected: " + err.Error() + "\nReply with the corrected plan as JSON only."},
		)
	}
	return res, lastErr
}

// ParsePlan reads a plan from model output. It tolerates prose or a ```json
// fence around the object, but rejects unknown fields.
func ParsePlan(text string) (Plan, error) {
	raw := extractJSONObject(text)
	if raw == "" {
		return Plan{}, errors.New("no JSON object in the reply")
	}
	dec := json.NewDecoder(bytes.NewReader([]byte(raw)))
	dec.DisallowUnknownFields()
	var p Plan
	if err := dec.Decode(&p); err != nil {
		return Plan{}, fmt.Errorf("plan JSON: %w", err)
	}
	Normalize(&p)
	return p, nil
}

// extractJSONObject returns the first balanced {...} in s, honouring strings.
func extractJSONObject(s string) string {
	start := strings.IndexByte(s, '{')
	if start < 0 {
		return ""
	}
	depth := 0
	inString := false
	escaped := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if inString {
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}
		switch c {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[start : i+1]
			}
		}
	}
	return ""
}

func (p *Planner) systemPrompt(r Rules) string {
	var b strings.Builder
	maxTasks := r.MaxTasks
	if maxTasks <= 0 {
		maxTasks = DefaultMaxTasks
	}
	b.WriteString(`You plan work for a personal assistant's orchestrator. Break the user's task into a small set of tasks that agents run, possibly in parallel. Use as few tasks as the job needs; one task is fine for a simple job.

Reply with one JSON object and nothing else:
{"goal": string, "tasks": [{"id": string, "title": string, "agent": string, "input": string, "integrations": [string], "depends_on": [string], "cost_hint": "low"|"med"|"high", "scout": {"narrow": [string]}}]}

Rules:
- id: short lowercase slug (letters, digits, - or _), unique.
- input: a complete, self-contained instruction for the agent. Outputs of the tasks it depends_on are given to it automatically.
- depends_on: ids that must finish first. No cycles. Leave empty when tasks are independent so they run in parallel.
- cost_hint: low for a quick lookup or formatting step, med for a normal tool-using task, high for broad research or long writing.
- scout.narrow: optional, up to 8 concrete hints that keep the agent's search narrow (which account, folder, sender, date range, site or search terms to check first). Only include hints you can infer from the task.
- integrations: only for agents that take them, and only from the list below.
`)
	fmt.Fprintf(&b, "- At most %d tasks.\n\nAgents:\n", maxTasks)
	for _, a := range r.Agents {
		fmt.Fprintf(&b, "- %s: %s", a.Name, a.Description)
		if a.UsesIntegrations {
			b.WriteString(" (takes integrations)")
		}
		b.WriteString("\n")
	}
	if r.Integrations != nil {
		list := strings.Join(r.Integrations, ", ")
		if list == "" {
			list = "(none connected)"
		}
		fmt.Fprintf(&b, "\nIntegrations: %s\n", list)
	}
	return b.String()
}
