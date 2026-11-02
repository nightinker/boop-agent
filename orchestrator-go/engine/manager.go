package engine

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sort"
	"sync"

	"boop-agent/orchestrator/plan"
)

// Planner turns a user task into a validated plan. *plan.Planner implements it.
type Planner interface {
	Plan(ctx context.Context, task string) (plan.Result, error)
}

// Config sets up a Manager.
type Config struct {
	Agents  []Agent
	Options Options
	Planner Planner // optional; without it only plans can be submitted
	// Merger writes a run's final answer from its step outputs. Optional;
	// without it the final steps' outputs are joined as they are.
	Merger Merger
	// Integrations lists what Boop's sub-agents can use, for checking submitted
	// plans. Optional.
	Integrations func(ctx context.Context) ([]string, error)
	MaxTasks     int // 0 means plan.DefaultMaxTasks
	KeepRuns     int // finished runs kept in memory; 0 means 100
}

// Overrides adjust the options for one run. Zero fields keep the defaults.
type Overrides struct {
	MaxTokens   int `json:"max_tokens,omitempty"`
	MaxParallel int `json:"max_parallel,omitempty"`
	// ConversationID ties Boop sub-agents spawned by the run to a Boop conversation.
	ConversationID string `json:"conversation_id,omitempty"`
}

// MaxParallelLimit caps a per-run max_parallel override.
const MaxParallelLimit = 8

// ErrNoPlanner is returned by SubmitTask when no planner is configured.
var ErrNoPlanner = errors.New("no planner configured (set ANTHROPIC_API_KEY)")

// ErrShuttingDown is returned once Shutdown has been called.
var ErrShuttingDown = errors.New("orchestrator is shutting down")

// Manager keeps runs in memory and runs them in the background. Runs are lost
// when the process exits.
type Manager struct {
	cfg    Config
	agents map[string]Agent
	specs  []plan.AgentSpec

	mu     sync.Mutex
	runs   map[string]*Run
	order  []string
	closed bool

	base context.Context
	stop context.CancelFunc
	wg   sync.WaitGroup
}

// NewManager builds a Manager. Agent names must be unique; later ones win.
func NewManager(cfg Config) *Manager {
	if cfg.KeepRuns <= 0 {
		cfg.KeepRuns = 100
	}
	cfg.Options = cfg.Options.WithDefaults()
	m := &Manager{cfg: cfg, agents: map[string]Agent{}, runs: map[string]*Run{}}
	for _, a := range cfg.Agents {
		m.agents[a.Spec().Name] = a
	}
	for _, a := range m.agents {
		m.specs = append(m.specs, a.Spec())
	}
	sort.Slice(m.specs, func(i, j int) bool { return m.specs[i].Name < m.specs[j].Name })
	m.base, m.stop = context.WithCancel(context.Background())
	return m
}

// Specs lists the registered agents.
func (m *Manager) Specs() []plan.AgentSpec { return append([]plan.AgentSpec(nil), m.specs...) }

// HasPlanner reports whether SubmitTask can be used.
func (m *Manager) HasPlanner() bool { return m.cfg.Planner != nil }

// Rules are what submitted plans are validated against.
func (m *Manager) Rules(ctx context.Context) plan.Rules {
	r := plan.Rules{Agents: m.specs, MaxTasks: m.cfg.MaxTasks}
	if m.cfg.Integrations != nil {
		if list, err := m.cfg.Integrations(ctx); err == nil {
			if list == nil {
				list = []string{}
			}
			r.Integrations = list
		}
	}
	return r
}

// Plan asks the planner for a plan without running it.
func (m *Manager) Plan(ctx context.Context, task string) (plan.Result, error) {
	if m.cfg.Planner == nil {
		return plan.Result{}, ErrNoPlanner
	}
	return m.cfg.Planner.Plan(ctx, task)
}

func (m *Manager) options(o Overrides) Options {
	opts := m.cfg.Options
	if o.MaxTokens > 0 {
		opts.MaxTokens = o.MaxTokens
	}
	if o.MaxParallel > 0 {
		opts.MaxParallel = min(o.MaxParallel, MaxParallelLimit)
	}
	return opts
}

// SubmitPlan validates p and starts running it. A bad plan returns a
// *plan.ValidationError and no run.
func (m *Manager) SubmitPlan(ctx context.Context, p plan.Plan, o Overrides) (RunStatus, error) {
	plan.Normalize(&p)
	if err := plan.Validate(p, m.Rules(ctx)); err != nil {
		return RunStatus{}, err
	}
	opts := m.options(o)
	return m.start(func(rctx context.Context, r *Run) { execute(rctx, r, p, m.agents, opts, m.cfg.Merger) }, "", o.ConversationID,
		func(r *Run) { r.setPlan(p, opts.WithDefaults()) })
}

// SubmitTask plans task in the background, then runs the plan.
func (m *Manager) SubmitTask(task string, o Overrides) (RunStatus, error) {
	if m.cfg.Planner == nil {
		return RunStatus{}, ErrNoPlanner
	}
	if task == "" {
		return RunStatus{}, plan.ErrEmptyTask
	}
	opts := m.options(o)
	return m.start(func(rctx context.Context, r *Run) {
		res, err := m.cfg.Planner.Plan(rctx, task)
		r.mu.Lock()
		r.status.PlannerTokens = res.Tokens
		r.mu.Unlock()
		if err != nil {
			state := RunFailed
			if rctx.Err() != nil {
				state = RunCancelled
			}
			r.finish(state, RunResult{Method: MergeNone}, "planning failed: "+err.Error())
			return
		}
		execute(rctx, r, res.Plan, m.agents, opts, m.cfg.Merger)
	}, task, o.ConversationID, nil)
}

func (m *Manager) start(work func(context.Context, *Run), task, conversationID string, init func(*Run)) (RunStatus, error) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return RunStatus{}, ErrShuttingDown
	}
	rctx, cancel := context.WithCancel(m.base)
	r := newRun(newID(), cancel)
	r.status.Task = task
	r.status.ConversationID = conversationID
	if init != nil {
		init(r)
	}
	m.runs[r.status.ID] = r
	m.order = append(m.order, r.status.ID)
	m.evictLocked()
	m.wg.Add(1)
	m.mu.Unlock()

	go func() {
		defer m.wg.Done()
		defer cancel()
		work(rctx, r)
	}()
	return r.Snapshot(), nil
}

// evictLocked drops the oldest finished runs beyond KeepRuns.
func (m *Manager) evictLocked() {
	finished := 0
	for _, id := range m.order {
		if m.runs[id].Snapshot().State.Terminal() {
			finished++
		}
	}
	kept := m.order[:0]
	for _, id := range m.order {
		if finished > m.cfg.KeepRuns && m.runs[id].Snapshot().State.Terminal() {
			delete(m.runs, id)
			finished--
			continue
		}
		kept = append(kept, id)
	}
	m.order = kept
}

// Run returns the run with id.
func (m *Manager) Run(id string) (*Run, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.runs[id]
	return r, ok
}

// List returns every run, newest first.
func (m *Manager) List() []RunStatus {
	m.mu.Lock()
	runs := make([]*Run, 0, len(m.order))
	for i := len(m.order) - 1; i >= 0; i-- {
		runs = append(runs, m.runs[m.order[i]])
	}
	m.mu.Unlock()
	out := make([]RunStatus, len(runs))
	for i, r := range runs {
		out[i] = r.Snapshot()
	}
	return out
}

// Cancel stops a run. found is false for an unknown id; cancelled is false
// when the run had already finished.
func (m *Manager) Cancel(id string) (status RunStatus, found, cancelled bool) {
	r, ok := m.Run(id)
	if !ok {
		return RunStatus{}, false, false
	}
	cancelled = r.Cancel()
	return r.Snapshot(), true, cancelled
}

// Shutdown cancels every run and waits for them to stop, or for ctx.
func (m *Manager) Shutdown(ctx context.Context) error {
	m.mu.Lock()
	m.closed = true
	m.mu.Unlock()
	m.stop()
	done := make(chan struct{})
	go func() { m.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func newID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "run_" + hex.EncodeToString(b[:])
}
