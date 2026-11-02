// Package engine runs a validated plan: it schedules ready tasks under a
// token budget and a parallelism cap, retries failures with backoff, and
// marks tasks it can't run as BLOCKED (an upstream task failed) or SKIPPED
// (deliberately not run: budget, an upstream skip, or a short-circuit).
package engine

import (
	"context"
	"errors"
	"time"

	"boop-agent/orchestrator/plan"
)

// TaskState is the state of one task.
type TaskState string

const (
	TaskPending   TaskState = "PENDING"
	TaskRunning   TaskState = "RUNNING"
	TaskSucceeded TaskState = "SUCCEEDED"
	TaskFailed    TaskState = "FAILED"
	// TaskBlocked: never ran because a task it depends on failed, was blocked or was cancelled.
	TaskBlocked TaskState = "BLOCKED"
	// TaskSkipped: deliberately not run (token budget, a skipped dependency, or a short-circuit).
	TaskSkipped   TaskState = "SKIPPED"
	TaskCancelled TaskState = "CANCELLED"
)

// Terminal reports whether the task is finished.
func (s TaskState) Terminal() bool { return s != TaskPending && s != TaskRunning }

// RunState is the state of a whole run.
type RunState string

const (
	RunPlanning RunState = "PLANNING"
	RunRunning  RunState = "RUNNING"
	// RunMerging: every step has finished; the report agent is writing the final answer.
	RunMerging   RunState = "MERGING"
	RunSucceeded RunState = "SUCCEEDED" // every task succeeded or was skipped
	RunFailed    RunState = "FAILED"    // planning failed, or a task failed or was blocked
	RunCancelled RunState = "CANCELLED"
)

// Terminal reports whether the run is finished.
func (s RunState) Terminal() bool { return s == RunSucceeded || s == RunFailed || s == RunCancelled }

// Input is what an agent gets for one task.
type Input struct {
	RunID string
	// ConversationID is the Boop conversation the run was submitted from, if any.
	ConversationID string
	Task           plan.Task
	Attempt        int
	// Deps holds the output of each task this one depends on, in depends_on order.
	Deps []DepOutput
}

// DepOutput is one upstream task's result.
type DepOutput struct {
	ID     string
	Title  string
	Output string
}

// Output is an agent's result.
type Output struct {
	Text string
	// Tokens actually used. 0 means unknown; the cost-hint estimate is charged instead.
	Tokens int
	// ShortCircuit says the goal is already met: tasks that haven't started are SKIPPED.
	ShortCircuit bool
}

// Agent runs one kind of task.
type Agent interface {
	Spec() plan.AgentSpec
	Run(ctx context.Context, in Input) (Output, error)
}

// permanentError marks a failure that retrying won't fix.
type permanentError struct{ err error }

func (e permanentError) Error() string { return e.err.Error() }
func (e permanentError) Unwrap() error { return e.err }

// Permanent wraps err so the engine doesn't retry it.
func Permanent(err error) error {
	if err == nil {
		return nil
	}
	return permanentError{err}
}

// IsPermanent reports whether err was wrapped with Permanent.
func IsPermanent(err error) bool {
	var p permanentError
	return errors.As(err, &p)
}

// Options control scheduling.
type Options struct {
	// MaxTokens is the token budget for a run's tasks. 0 means unlimited.
	MaxTokens int
	// MaxParallel is how many tasks may run at once. 0 means 2.
	MaxParallel int
	// MaxAttempts is how many times a task is tried before it FAILS. 0 means 3.
	MaxAttempts int
	// BackoffBase and BackoffMax shape the exponential retry delay.
	BackoffBase time.Duration
	BackoffMax  time.Duration
	// TaskTimeout bounds one attempt. 0 means none.
	TaskTimeout time.Duration
	// CostTokens is the estimated token cost per cost hint, used to reserve
	// budget before a task starts.
	CostTokens map[plan.CostHint]int
}

// DefaultCostTokens are the estimates used when Options.CostTokens is unset.
var DefaultCostTokens = map[plan.CostHint]int{plan.CostLow: 2_000, plan.CostMed: 8_000, plan.CostHigh: 24_000}

// WithDefaults fills unset options.
func (o Options) WithDefaults() Options {
	if o.MaxParallel <= 0 {
		o.MaxParallel = 2
	}
	if o.MaxAttempts <= 0 {
		o.MaxAttempts = 3
	}
	if o.BackoffBase <= 0 {
		o.BackoffBase = 500 * time.Millisecond
	}
	if o.BackoffMax <= 0 {
		o.BackoffMax = 10 * time.Second
	}
	if o.CostTokens == nil {
		o.CostTokens = DefaultCostTokens
	}
	return o
}

// estimate returns the reserved tokens for a task.
func (o Options) estimate(t plan.Task) int {
	if n, ok := o.CostTokens[t.CostHint]; ok {
		return n
	}
	return DefaultCostTokens[plan.CostHigh]
}

// backoff returns the delay before retry number attempt (1-based).
func (o Options) backoff(attempt int) time.Duration {
	d := o.BackoffBase
	for i := 1; i < attempt && d < o.BackoffMax; i++ {
		d *= 2
	}
	if d > o.BackoffMax {
		d = o.BackoffMax
	}
	return d
}

// TaskStatus is a snapshot of one task.
type TaskStatus struct {
	ID         string     `json:"id"`
	Title      string     `json:"title,omitempty"`
	Agent      string     `json:"agent"`
	State      TaskState  `json:"state"`
	Attempts   int        `json:"attempts"`
	Tokens     int        `json:"tokens"`
	Output     string     `json:"output,omitempty"`
	Error      string     `json:"error,omitempty"`
	Reason     string     `json:"reason,omitempty"` // why BLOCKED or SKIPPED
	StartedAt  *time.Time `json:"started_at,omitempty"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
}

// RunStatus is a snapshot of a run.
type RunStatus struct {
	ID             string       `json:"id"`
	State          RunState     `json:"state"`
	ConversationID string       `json:"conversation_id,omitempty"`
	Task           string       `json:"task,omitempty"` // the user task, when the run was planned from one
	Plan           *plan.Plan   `json:"plan,omitempty"`
	Tasks          []TaskStatus `json:"tasks"`
	TokenBudget    int          `json:"token_budget"`
	TokensUsed     int          `json:"tokens_used"`
	PlannerTokens  int          `json:"planner_tokens,omitempty"`
	MaxParallel    int          `json:"max_parallel"`
	Output         string       `json:"output,omitempty"` // the final answer (same as Result.Answer)
	Result         *RunResult   `json:"result,omitempty"` // set once the run has finished
	Error          string       `json:"error,omitempty"`
	CreatedAt      time.Time    `json:"created_at"`
	FinishedAt     *time.Time   `json:"finished_at,omitempty"`
}
