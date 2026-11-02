package engine

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"boop-agent/orchestrator/plan"
)

// Run is one execution of a plan. Its status is safe to read at any time.
type Run struct {
	mu     sync.Mutex
	status RunStatus
	index  map[string]int
	cancel context.CancelFunc
	done   chan struct{}
}

func newRun(id string, cancel context.CancelFunc) *Run {
	return &Run{
		status: RunStatus{ID: id, State: RunPlanning, Tasks: []TaskStatus{}, CreatedAt: time.Now().UTC()},
		index:  map[string]int{},
		cancel: cancel,
		done:   make(chan struct{}),
	}
}

// Snapshot returns a copy of the run's current status.
func (r *Run) Snapshot() RunStatus {
	r.mu.Lock()
	defer r.mu.Unlock()
	s := r.status
	s.Tasks = append([]TaskStatus(nil), r.status.Tasks...)
	return s
}

// Cancel stops the run. It returns false if the run had already finished.
func (r *Run) Cancel() bool {
	r.mu.Lock()
	terminal := r.status.State.Terminal()
	r.mu.Unlock()
	if terminal {
		return false
	}
	r.cancel()
	return true
}

// Done is closed when the run finishes.
func (r *Run) Done() <-chan struct{} { return r.done }

func (r *Run) setPlan(p plan.Plan, o Options) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.status.Plan = &p
	r.status.State = RunRunning
	r.status.TokenBudget = o.MaxTokens
	r.status.MaxParallel = o.MaxParallel
	r.status.Tasks = make([]TaskStatus, len(p.Tasks))
	for i, t := range p.Tasks {
		r.index[t.ID] = i
		r.status.Tasks[i] = TaskStatus{ID: t.ID, Title: t.Title, Agent: t.Agent, State: TaskPending}
	}
}

func (r *Run) updateTask(id string, fn func(*TaskStatus)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if i, ok := r.index[id]; ok {
		fn(&r.status.Tasks[i])
	}
}

func (r *Run) setTokensUsed(n int) {
	r.mu.Lock()
	r.status.TokensUsed = n
	r.mu.Unlock()
}

func (r *Run) finish(state RunState, output, errMsg string) {
	r.mu.Lock()
	now := time.Now().UTC()
	r.status.State = state
	r.status.Output = output
	if errMsg != "" {
		r.status.Error = errMsg
	}
	r.status.FinishedAt = &now
	r.mu.Unlock()
	close(r.done)
}

type taskResult struct {
	id     string
	state  TaskState
	out    Output
	err    error
	tokens int
	ran    bool // at least one attempt reached the agent and finished
}

// execute runs p to completion and finishes r. ctx cancellation cancels the run.
func execute(ctx context.Context, r *Run, p plan.Plan, agents map[string]Agent, o Options) {
	o = o.WithDefaults()
	r.setPlan(p, o)

	byID := map[string]plan.Task{}
	state := map[string]TaskState{}
	for _, t := range p.Tasks {
		byID[t.ID] = t
		state[t.ID] = TaskPending
	}
	outputs := map[string]string{}
	estimates := map[string]int{}
	results := make(chan taskResult)
	running, reserved, used := 0, 0, 0
	shortCircuitBy := ""
	ctxDone := ctx.Done()

	settle := func(id string, s TaskState, reason string) {
		state[id] = s
		now := time.Now().UTC()
		r.updateTask(id, func(ts *TaskStatus) {
			ts.State = s
			ts.Reason = reason
			ts.FinishedAt = &now
		})
	}

	// resolve settles pending tasks that can no longer run. It reports whether anything changed.
	resolve := func() bool {
		changedAny := false
		for changed := true; changed; {
			changed = false
			for _, t := range p.Tasks {
				if state[t.ID] != TaskPending {
					continue
				}
				switch {
				case ctx.Err() != nil:
					settle(t.ID, TaskCancelled, "run cancelled")
					changed = true
					continue
				case shortCircuitBy != "":
					settle(t.ID, TaskSkipped, fmt.Sprintf("short-circuited: %s already met the goal", shortCircuitBy))
					changed = true
					continue
				}
				if s, reason := blockedBy(t, state); s != "" {
					settle(t.ID, s, reason)
					changed = true
				}
			}
			changedAny = changedAny || changed
		}
		return changedAny
	}

	ready := func() []plan.Task {
		var out []plan.Task
		for _, t := range p.Tasks {
			if state[t.ID] != TaskPending {
				continue
			}
			ok := true
			for _, d := range t.DependsOn {
				if state[d] != TaskSucceeded {
					ok = false
					break
				}
			}
			if ok {
				out = append(out, t)
			}
		}
		// Cheapest first, so small tasks aren't starved by big ones under a tight budget.
		sort.SliceStable(out, func(i, j int) bool { return out[i].CostHint.Rank() < out[j].CostHint.Rank() })
		return out
	}

	for {
		progressed := resolve()
		if ctx.Err() == nil && shortCircuitBy == "" {
			for _, t := range ready() {
				if running >= o.MaxParallel {
					break
				}
				est := o.estimate(t)
				if o.MaxTokens > 0 {
					if used+est > o.MaxTokens {
						settle(t.ID, TaskSkipped, fmt.Sprintf("token budget: needs ~%d, %d left", est, o.MaxTokens-used))
						progressed = true
						continue
					}
					if used+reserved+est > o.MaxTokens {
						continue // wait for running tasks to release their reservation
					}
				}
				agent, ok := agents[t.Agent]
				if !ok {
					state[t.ID] = TaskFailed
					now := time.Now().UTC()
					r.updateTask(t.ID, func(ts *TaskStatus) {
						ts.State, ts.Error, ts.FinishedAt = TaskFailed, "unknown agent "+t.Agent, &now
					})
					progressed = true
					continue
				}
				state[t.ID] = TaskRunning
				estimates[t.ID] = est
				reserved += est
				running++
				in := Input{RunID: r.status.ID, Task: t}
				for _, d := range t.DependsOn {
					in.Deps = append(in.Deps, DepOutput{ID: d, Title: byID[d].Title, Output: outputs[d]})
				}
				now := time.Now().UTC()
				r.updateTask(t.ID, func(ts *TaskStatus) { ts.State, ts.StartedAt = TaskRunning, &now })
				go func(t plan.Task, in Input) { results <- runTask(ctx, r, agent, in, o) }(t, in)
			}
		}
		if running == 0 {
			if progressed {
				continue
			}
			break // nothing running and nothing more can start
		}
		select {
		case <-ctxDone:
			ctxDone = nil // handled; running tasks see ctx and report back
		case res := <-results:
			running--
			est := estimates[res.id]
			reserved -= est
			charged := res.tokens
			if charged == 0 && res.ran {
				charged = est
			}
			used += charged
			r.setTokensUsed(used)
			state[res.id] = res.state
			now := time.Now().UTC()
			r.updateTask(res.id, func(ts *TaskStatus) {
				ts.State = res.state
				ts.Tokens = charged
				ts.FinishedAt = &now
				if res.state == TaskSucceeded {
					ts.Output = res.out.Text
					ts.Error = ""
				} else if res.err != nil {
					ts.Error = res.err.Error()
				}
			})
			if res.state == TaskSucceeded {
				outputs[res.id] = res.out.Text
				if res.out.ShortCircuit && shortCircuitBy == "" {
					shortCircuitBy = res.id
				}
			}
		}
	}

	// Anything still pending is unreachable; validation should prevent this.
	for _, t := range p.Tasks {
		if state[t.ID] == TaskPending {
			settle(t.ID, TaskBlocked, "unreachable")
		}
	}

	final := RunSucceeded
	if ctx.Err() != nil {
		final = RunCancelled
	} else {
		for _, s := range state {
			if s == TaskFailed || s == TaskBlocked {
				final = RunFailed
				break
			}
		}
	}
	r.finish(final, sinkOutput(p, state, outputs), "")
}

// blockedBy says whether t can no longer run because of a dependency: BLOCKED
// when one failed, was blocked or cancelled, SKIPPED when one was skipped.
// Failures win over skips.
func blockedBy(t plan.Task, state map[string]TaskState) (TaskState, string) {
	for _, d := range t.DependsOn {
		switch state[d] {
		case TaskFailed, TaskBlocked, TaskCancelled:
			return TaskBlocked, fmt.Sprintf("depends on %s, which is %s", d, state[d])
		}
	}
	for _, d := range t.DependsOn {
		if state[d] == TaskSkipped {
			return TaskSkipped, fmt.Sprintf("depends on %s, which was skipped", d)
		}
	}
	return "", ""
}

// runTask tries one task until it succeeds, fails permanently, runs out of
// attempts, or the run is cancelled.
func runTask(ctx context.Context, r *Run, agent Agent, in Input, o Options) taskResult {
	res := taskResult{id: in.Task.ID}
	for attempt := 1; ; attempt++ {
		in.Attempt = attempt
		r.updateTask(in.Task.ID, func(ts *TaskStatus) { ts.Attempts = attempt })
		actx, cancel := ctx, context.CancelFunc(func() {})
		if o.TaskTimeout > 0 {
			actx, cancel = context.WithTimeout(ctx, o.TaskTimeout)
		}
		out, err := safeRun(actx, agent, in)
		cancel()
		res.tokens += out.Tokens
		if ctx.Err() != nil {
			res.state, res.err = TaskCancelled, ctx.Err()
			return res
		}
		res.ran = true
		if err == nil {
			res.state, res.out = TaskSucceeded, out
			return res
		}
		res.err = err
		if IsPermanent(err) || attempt >= o.MaxAttempts {
			res.state = TaskFailed
			return res
		}
		r.updateTask(in.Task.ID, func(ts *TaskStatus) { ts.Error = err.Error() + " (retrying)" })
		timer := time.NewTimer(o.backoff(attempt))
		select {
		case <-ctx.Done():
			timer.Stop()
			res.state, res.err = TaskCancelled, ctx.Err()
			return res
		case <-timer.C:
		}
	}
}

func safeRun(ctx context.Context, agent Agent, in Input) (out Output, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = Permanent(fmt.Errorf("agent panicked: %v", p))
		}
	}()
	return agent.Run(ctx, in)
}

// sinkOutput joins the outputs of succeeded tasks nothing else depends on.
func sinkOutput(p plan.Plan, state map[string]TaskState, outputs map[string]string) string {
	dependents := p.Dependents()
	var sinks []plan.Task
	for _, t := range p.Tasks {
		if len(dependents[t.ID]) == 0 && state[t.ID] == TaskSucceeded {
			sinks = append(sinks, t)
		}
	}
	if len(sinks) == 1 {
		return outputs[sinks[0].ID]
	}
	var b strings.Builder
	for i, t := range sinks {
		if i > 0 {
			b.WriteString("\n\n")
		}
		title := t.Title
		if title == "" {
			title = t.ID
		}
		fmt.Fprintf(&b, "## %s\n%s", title, outputs[t.ID])
	}
	return b.String()
}
