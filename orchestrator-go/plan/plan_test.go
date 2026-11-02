package plan

import (
	"context"
	"errors"
	"strings"
	"testing"

	"boop-agent/orchestrator/llm"
)

var testAgents = []AgentSpec{
	{Name: "boop", Description: "Boop sub-agent", UsesIntegrations: true},
	{Name: "llm", Description: "thinks"},
}

func rules() Rules { return Rules{Agents: testAgents, Integrations: []string{"gmail", "calendar"}} }

func validPlan() Plan {
	return Plan{Goal: "g", Tasks: []Task{
		{ID: "mail", Agent: "boop", Input: "find mail", Integrations: []string{"gmail"}, CostHint: CostMed, Scout: &Scout{Narrow: []string{"from:bank"}}},
		{ID: "cal", Agent: "boop", Input: "find events", Integrations: []string{"calendar"}, CostHint: CostLow},
		{ID: "sum", Agent: "llm", Input: "summarize", DependsOn: []string{"mail", "cal"}, CostHint: CostLow},
	}}
}

func TestValidateAcceptsDAG(t *testing.T) {
	if err := Validate(validPlan(), rules()); err != nil {
		t.Fatal(err)
	}
}

func TestValidateRejects(t *testing.T) {
	cases := map[string]struct {
		mutate func(*Plan)
		want   string
	}{
		"empty":           {func(p *Plan) { p.Tasks = nil }, "no tasks"},
		"dup id":          {func(p *Plan) { p.Tasks[1].ID = "mail" }, "duplicate id"},
		"bad id":          {func(p *Plan) { p.Tasks[0].ID = "Has Spaces" }, "id must be"},
		"unknown agent":   {func(p *Plan) { p.Tasks[0].Agent = "nope" }, `unknown agent "nope"`},
		"bad cost":        {func(p *Plan) { p.Tasks[0].CostHint = "huge" }, "cost_hint"},
		"missing input":   {func(p *Plan) { p.Tasks[0].Input = "" }, "no input"},
		"unknown dep":     {func(p *Plan) { p.Tasks[2].DependsOn = []string{"ghost"} }, "unknown task"},
		"self dep":        {func(p *Plan) { p.Tasks[0].DependsOn = []string{"mail"} }, "depends on itself"},
		"cycle":           {func(p *Plan) { p.Tasks[0].DependsOn = []string{"sum"} }, "cycle"},
		"unknown integ":   {func(p *Plan) { p.Tasks[0].Integrations = []string{"slack"} }, `unknown integration "slack"`},
		"integ on llm":    {func(p *Plan) { p.Tasks[2].Integrations = []string{"gmail"} }, "does not take integrations"},
		"too many scouts": {func(p *Plan) { p.Tasks[0].Scout.Narrow = make([]string, 9) }, "scout.narrow"},
		"too many tasks": {func(p *Plan) {
			for i := 0; i < DefaultMaxTasks; i++ {
				p.Tasks = append(p.Tasks, Task{ID: "x" + strings.Repeat("y", i), Agent: "llm", Input: "i", CostHint: CostLow})
			}
		}, "the limit is"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			p := validPlan()
			c.mutate(&p)
			err := Validate(p, rules())
			var ve *ValidationError
			if !errors.As(err, &ve) || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("want error containing %q, got %v", c.want, err)
			}
		})
	}
}

func TestParsePlanToleratesFenceAndNormalizes(t *testing.T) {
	text := "Here you go:\n```json\n" + `{"goal":"g","tasks":[{"id":" a ","agent":"llm","input":"say {hi}","cost_hint":"Medium","depends_on":[" "],"scout":{"narrow":[]}}]}` + "\n```"
	p, err := ParsePlan(text)
	if err != nil {
		t.Fatal(err)
	}
	got := p.Tasks[0]
	if got.ID != "a" || got.CostHint != CostMed || got.Input != "say {hi}" || got.DependsOn != nil || got.Scout != nil {
		t.Fatalf("not normalized: %+v", got)
	}
}

func TestParsePlanRejectsUnknownFieldsAndProse(t *testing.T) {
	if _, err := ParsePlan(`{"goal":"g","tasks":[],"extra":1}`); err == nil {
		t.Fatal("want unknown field error")
	}
	if _, err := ParsePlan("no json here"); err == nil {
		t.Fatal("want no-JSON error")
	}
}

const goodReply = `{"goal":"weekly brief","tasks":[
 {"id":"mail","agent":"boop","input":"Find bills","integrations":["gmail"],"cost_hint":"med","scout":{"narrow":["subject:invoice","last 7 days"]}},
 {"id":"brief","agent":"llm","input":"Write a brief","depends_on":["mail"],"cost_hint":"low"}]}`

func TestPlannerReturnsValidatedPlan(t *testing.T) {
	m := &llm.Mock{Replies: []llm.MockReply{{Text: goodReply, Tokens: 50}}}
	p := &Planner{LLM: m, Agents: testAgents, Integrations: func(context.Context) ([]string, error) { return []string{"gmail"}, nil }}
	res, err := p.Plan(context.Background(), "brief me on bills")
	if err != nil {
		t.Fatal(err)
	}
	if res.Attempts != 1 || res.Tokens != 50 || len(res.Plan.Tasks) != 2 || res.Plan.Tasks[0].Scout.Narrow[0] != "subject:invoice" {
		t.Fatalf("unexpected result %+v", res)
	}
	sys := m.Calls()[0].System
	if !strings.Contains(sys, "boop: Boop sub-agent (takes integrations)") || !strings.Contains(sys, "Integrations: gmail") {
		t.Fatalf("catalog missing from prompt:\n%s", sys)
	}
}

func TestPlannerRetriesWithProblems(t *testing.T) {
	bad := `{"goal":"g","tasks":[{"id":"a","agent":"wizard","input":"x","cost_hint":"low"}]}`
	m := &llm.Mock{Replies: []llm.MockReply{{Text: bad}, {Text: goodReply}}}
	p := &Planner{LLM: m, Agents: testAgents}
	res, err := p.Plan(context.Background(), "t")
	if err != nil {
		t.Fatal(err)
	}
	if res.Attempts != 2 {
		t.Fatalf("attempts = %d", res.Attempts)
	}
	second := m.Calls()[1].Messages
	if len(second) != 3 || !strings.Contains(second[2].Content, `unknown agent "wizard"`) {
		t.Fatalf("feedback not sent: %+v", second)
	}
}

func TestPlannerGivesUp(t *testing.T) {
	m := &llm.Mock{Replies: []llm.MockReply{{Text: `{"goal":"g","tasks":[]}`}}}
	p := &Planner{LLM: m, Agents: testAgents, MaxAttempts: 3}
	res, err := p.Plan(context.Background(), "t")
	var ve *ValidationError
	if !errors.As(err, &ve) || res.Attempts != 3 {
		t.Fatalf("want validation error after 3 attempts, got %v (%d)", err, res.Attempts)
	}
}

func TestPlannerProviderErrorAndEmptyTask(t *testing.T) {
	p := &Planner{LLM: &llm.Mock{Replies: []llm.MockReply{{Err: errors.New("down")}}}, Agents: testAgents}
	if _, err := p.Plan(context.Background(), "t"); err == nil || !strings.Contains(err.Error(), "down") {
		t.Fatalf("got %v", err)
	}
	if _, err := p.Plan(context.Background(), "  "); !errors.Is(err, ErrEmptyTask) {
		t.Fatalf("got %v", err)
	}
}
