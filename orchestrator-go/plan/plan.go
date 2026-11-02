// Package plan defines the orchestrator's plan format (a DAG of tasks) and
// checks that a plan is safe to run.
package plan

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// CostHint is a rough token-cost class for a task.
type CostHint string

const (
	CostLow  CostHint = "low"
	CostMed  CostHint = "med"
	CostHigh CostHint = "high"
)

// Valid reports whether c is one of low, med, high.
func (c CostHint) Valid() bool { return c == CostLow || c == CostMed || c == CostHigh }

// Rank orders cost hints: low < med < high.
func (c CostHint) Rank() int {
	switch c {
	case CostLow:
		return 0
	case CostMed:
		return 1
	default:
		return 2
	}
}

// Scout holds hints that keep an agent's search narrow: the specific
// sources, folders, accounts, people or search terms to look at first, so it
// doesn't sweep everything.
type Scout struct {
	Narrow []string `json:"narrow,omitempty"`
}

// Task is one node of the plan.
type Task struct {
	ID           string   `json:"id"`
	Title        string   `json:"title,omitempty"`
	Agent        string   `json:"agent"`
	Input        string   `json:"input"`
	Integrations []string `json:"integrations,omitempty"`
	DependsOn    []string `json:"depends_on,omitempty"`
	CostHint     CostHint `json:"cost_hint"`
	Scout        *Scout   `json:"scout,omitempty"`
}

// Plan is a goal broken into tasks. Tasks may run in parallel unless one
// depends on another.
type Plan struct {
	Goal  string `json:"goal"`
	Tasks []Task `json:"tasks"`
}

// AgentSpec describes an agent the planner may assign tasks to.
type AgentSpec struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// UsesIntegrations means tasks for this agent may list integrations.
	UsesIntegrations bool `json:"uses_integrations"`
}

// Limits used by Validate.
const (
	DefaultMaxTasks = 12
	MaxInputChars   = 8000
	MaxScoutHints   = 8
)

var idPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,39}$`)

// Rules are what a plan is checked against.
type Rules struct {
	Agents []AgentSpec
	// Integrations available to integration-using agents. nil skips the check.
	Integrations []string
	MaxTasks     int // 0 means DefaultMaxTasks
}

// ValidationError lists every problem found in a plan.
type ValidationError struct{ Problems []string }

func (e *ValidationError) Error() string {
	return "invalid plan: " + strings.Join(e.Problems, "; ")
}

// Normalize trims fields and maps common cost-hint spellings ("medium") to
// the canonical ones. It does not check anything.
func Normalize(p *Plan) {
	p.Goal = strings.TrimSpace(p.Goal)
	for i := range p.Tasks {
		t := &p.Tasks[i]
		t.ID = strings.TrimSpace(t.ID)
		t.Title = strings.TrimSpace(t.Title)
		t.Agent = strings.TrimSpace(t.Agent)
		t.Input = strings.TrimSpace(t.Input)
		switch strings.ToLower(strings.TrimSpace(string(t.CostHint))) {
		case "low", "l":
			t.CostHint = CostLow
		case "med", "medium", "m", "mid":
			t.CostHint = CostMed
		case "high", "h":
			t.CostHint = CostHigh
		}
		t.DependsOn = trimAll(t.DependsOn)
		t.Integrations = trimAll(t.Integrations)
		if t.Scout != nil {
			t.Scout.Narrow = trimAll(t.Scout.Narrow)
			if len(t.Scout.Narrow) == 0 {
				t.Scout = nil
			}
		}
	}
}

func trimAll(in []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, s := range in {
		s = strings.TrimSpace(s)
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// Validate checks a plan: at least one task, unique well-formed ids, known
// agents and integrations, valid cost hints, dependencies that exist, and no
// cycles. It returns a *ValidationError listing every problem.
func Validate(p Plan, r Rules) error {
	var problems []string
	add := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }

	maxTasks := r.MaxTasks
	if maxTasks <= 0 {
		maxTasks = DefaultMaxTasks
	}
	if len(p.Tasks) == 0 {
		add("plan has no tasks")
	}
	if len(p.Tasks) > maxTasks {
		add("plan has %d tasks, the limit is %d", len(p.Tasks), maxTasks)
	}
	agents := map[string]AgentSpec{}
	for _, a := range r.Agents {
		agents[a.Name] = a
	}
	var integrations map[string]bool
	if r.Integrations != nil {
		integrations = map[string]bool{}
		for _, i := range r.Integrations {
			integrations[i] = true
		}
	}

	ids := map[string]bool{}
	for i, t := range p.Tasks {
		label := fmt.Sprintf("task %d", i+1)
		if t.ID != "" {
			label = fmt.Sprintf("task %q", t.ID)
		}
		switch {
		case t.ID == "":
			add("%s has no id", label)
		case !idPattern.MatchString(t.ID):
			add("%s: id must be lowercase letters, digits, - or _ (max 40)", label)
		case ids[t.ID]:
			add("%s: duplicate id", label)
		}
		ids[t.ID] = true
		if t.Input == "" {
			add("%s has no input", label)
		}
		if len(t.Input) > MaxInputChars {
			add("%s: input is longer than %d characters", label, MaxInputChars)
		}
		if !t.CostHint.Valid() {
			add("%s: cost_hint must be low, med or high (got %q)", label, t.CostHint)
		}
		spec, ok := agents[t.Agent]
		if !ok {
			add("%s: unknown agent %q", label, t.Agent)
		} else if len(t.Integrations) > 0 && !spec.UsesIntegrations {
			add("%s: agent %q does not take integrations", label, t.Agent)
		}
		if integrations != nil {
			for _, in := range t.Integrations {
				if !integrations[in] {
					add("%s: unknown integration %q", label, in)
				}
			}
		}
		if t.Scout != nil && len(t.Scout.Narrow) > MaxScoutHints {
			add("%s: at most %d scout.narrow hints", label, MaxScoutHints)
		}
	}
	for _, t := range p.Tasks {
		for _, d := range t.DependsOn {
			if d == t.ID {
				add("task %q depends on itself", t.ID)
			} else if !ids[d] {
				add("task %q depends on unknown task %q", t.ID, d)
			}
		}
	}
	if len(problems) == 0 {
		if cycle := findCycle(p); len(cycle) > 0 {
			add("dependency cycle: %s", strings.Join(cycle, " -> "))
		}
	}
	if len(problems) > 0 {
		return &ValidationError{Problems: problems}
	}
	return nil
}

// findCycle returns the ids on one dependency cycle, or nil.
func findCycle(p Plan) []string {
	deps := map[string][]string{}
	for _, t := range p.Tasks {
		deps[t.ID] = t.DependsOn
	}
	const (
		unvisited = 0
		visiting  = 1
		done      = 2
	)
	state := map[string]int{}
	var stack []string
	var cycle []string
	var visit func(id string) bool
	visit = func(id string) bool {
		state[id] = visiting
		stack = append(stack, id)
		for _, d := range deps[id] {
			switch state[d] {
			case visiting:
				for i, s := range stack {
					if s == d {
						cycle = append(append([]string{}, stack[i:]...), d)
					}
				}
				return true
			case unvisited:
				if visit(d) {
					return true
				}
			}
		}
		stack = stack[:len(stack)-1]
		state[id] = done
		return false
	}
	ids := make([]string, 0, len(deps))
	for id := range deps {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if state[id] == unvisited && visit(id) {
			return cycle
		}
	}
	return nil
}

// Dependents maps each task id to the ids of tasks that depend on it.
func (p Plan) Dependents() map[string][]string {
	out := map[string][]string{}
	for _, t := range p.Tasks {
		for _, d := range t.DependsOn {
			out[d] = append(out[d], t.ID)
		}
	}
	return out
}
