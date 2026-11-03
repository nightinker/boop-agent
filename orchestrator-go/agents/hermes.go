package agents

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"boop-agent/orchestrator/engine"
	"boop-agent/orchestrator/plan"
)

// Hermes runs a task with Hermes Agent (NousResearch/hermes-agent) on this
// machine, through its one-shot CLI: `hermes chat --query-file -`. It is the
// orchestrator's hands-on tester: a real headless browser (navigate, click,
// fill forms, screenshot and look at the page), a shell to run test suites,
// and the web. It runs wherever Boop runs, the Mac or the Linux server, as
// long as `hermes` is installed there (see FindHermes).
//
// The model is the Claude subscription the `claude` CLI is logged into, via
// Hermes' official claude-subscription-directsdk plugin: no API key, the same
// account Boop's Agent SDK runtime uses. That provider refuses an inherited
// ANTHROPIC_API_KEY, so the child never gets one.
type Hermes struct {
	Bin      string
	Provider string        // "" leaves Hermes' own configured provider
	Model    string        // "" leaves the provider's default
	Toolsets string        // comma-separated
	MaxTurns int           // 0 means 60
	Timeout  time.Duration // 0 means 15 minutes
	// Yolo auto-approves every tool call. A one-shot run has nobody to approve
	// anything, so without it a shell command waits until the timeout.
	Yolo bool
	// MaxOutputChars caps what is passed on to later steps; 0 means 20,000.
	MaxOutputChars int
	// Env is the environment the child starts from; nil means os.Environ().
	Env []string
}

// Defaults for HermesFromEnv.
const (
	HermesDefaultProvider = "claude-subscription-directsdk-experimental"
	HermesDefaultModel    = "sonnet"
	HermesDefaultToolsets = "browser,vision,web,terminal,file"
)

// FindHermes returns the hermes executable: HERMES_BIN if set, then PATH,
// then the installer's usual places (a sidecar started by launchd or systemd
// can have a thin PATH). "" when it isn't installed.
func FindHermes(getenv func(string) string) string {
	if v := strings.TrimSpace(getenv("HERMES_BIN")); v != "" {
		if isExecutable(v) {
			return v
		}
		return ""
	}
	if p, err := exec.LookPath("hermes"); err == nil {
		return p
	}
	home := getenv("HOME")
	for _, p := range []string{
		filepath.Join(home, ".local", "bin", "hermes"),
		filepath.Join(home, ".hermes", "bin", "hermes"),
		"/usr/local/bin/hermes",
		"/opt/homebrew/bin/hermes",
	} {
		if home == "" && strings.HasPrefix(p, "/.") {
			continue
		}
		if isExecutable(p) {
			return p
		}
	}
	return ""
}

func isExecutable(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir() && st.Mode()&0o111 != 0
}

// HermesFromEnv builds the agent from ORCHESTRATOR_HERMES_* settings, or
// returns nil when Hermes is off (ORCHESTRATOR_HERMES=off) or not installed,
// in which case the planner simply never sees the agent. lookupEnv is
// os.LookupEnv in the binary: a setting present but empty (say
// ORCHESTRATOR_HERMES_PROVIDER=) leaves that choice to Hermes' own config.
func HermesFromEnv(lookupEnv func(string) (string, bool)) *Hermes {
	getenv := func(k string) string { v, _ := lookupEnv(k); return v }
	if strings.EqualFold(strings.TrimSpace(getenv("ORCHESTRATOR_HERMES")), "off") {
		return nil
	}
	bin := FindHermes(getenv)
	if bin == "" {
		return nil
	}
	pick := func(key, def string) string {
		if v, ok := lookupEnv(key); ok {
			return strings.TrimSpace(v)
		}
		return def
	}
	h := &Hermes{
		Bin:      bin,
		Provider: pick("ORCHESTRATOR_HERMES_PROVIDER", HermesDefaultProvider),
		Model:    pick("ORCHESTRATOR_HERMES_MODEL", HermesDefaultModel),
		Toolsets: pick("ORCHESTRATOR_HERMES_TOOLSETS", HermesDefaultToolsets),
		Yolo:     !strings.EqualFold(strings.TrimSpace(getenv("ORCHESTRATOR_HERMES_YOLO")), "off"),
	}
	if n, err := strconv.Atoi(strings.TrimSpace(getenv("ORCHESTRATOR_HERMES_MAX_TURNS"))); err == nil && n > 0 {
		h.MaxTurns = n
	}
	if d, err := time.ParseDuration(strings.TrimSpace(getenv("ORCHESTRATOR_HERMES_TIMEOUT"))); err == nil && d > 0 {
		h.Timeout = d
	}
	return h
}

func (h *Hermes) Spec() plan.AgentSpec {
	return plan.AgentSpec{
		Name: "hermes",
		Description: "Hermes Agent on this machine, for hands-on testing: drives a real headless browser " +
			"(open a URL, click, type, fill forms, take screenshots and inspect them visually), runs shell " +
			"commands and test suites, and reads the web. Use it to check that a site or app actually works " +
			"end to end, reproduce a UI bug, compare a page before and after, or capture screenshots. " +
			"It reports what it did, what passed or failed, and the file paths of any screenshots. Slow and " +
			"thorough: cost_hint high.",
	}
}

// screenshotNote asks Hermes to report its screenshots in a form Boop can pick up.
const screenshotNote = "\n\nWhen you are done, answer with what you did and what you found " +
	"(what worked, what failed, with the exact error text). If you took screenshots, end with a " +
	"line `Screenshots:` followed by one absolute file path per line."

var ansiPattern = regexp.MustCompile(`\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\a]*(\a|\x1b\\)`)

func (h *Hermes) args() []string {
	args := []string{"chat", "--query-file", "-"}
	if h.Provider != "" {
		args = append(args, "--provider", h.Provider)
	}
	if h.Model != "" {
		args = append(args, "--model", h.Model)
	}
	if h.Toolsets != "" {
		args = append(args, "--toolsets", h.Toolsets)
	}
	turns := h.MaxTurns
	if turns <= 0 {
		turns = 60
	}
	args = append(args, "--max-turns", strconv.Itoa(turns))
	if h.Yolo {
		args = append(args, "--yolo")
	}
	return args
}

// childEnv is the environment Hermes starts with: the sidecar's, minus any
// Anthropic API key or endpoint override (the subscription provider refuses
// them, and a key must never silently replace the subscription), plus USER and
// LOGNAME, which the claude CLI's login check needs under launchd/systemd.
func (h *Hermes) childEnv() []string {
	base := h.Env
	if base == nil {
		base = os.Environ()
	}
	drop := map[string]bool{"ANTHROPIC_API_KEY": true, "ANTHROPIC_AUTH_TOKEN": true, "ANTHROPIC_BASE_URL": true, "CLAUDE_CODE_USE_BEDROCK": true, "CLAUDE_CODE_USE_VERTEX": true}
	out := make([]string, 0, len(base)+2)
	has := map[string]bool{}
	for _, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		if drop[k] {
			continue
		}
		has[k] = true
		out = append(out, kv)
	}
	if !has["USER"] || !has["LOGNAME"] {
		if name := currentUser(); name != "" {
			if !has["USER"] {
				out = append(out, "USER="+name)
			}
			if !has["LOGNAME"] {
				out = append(out, "LOGNAME="+name)
			}
		}
	}
	return out
}

func (h *Hermes) Run(ctx context.Context, in engine.Input) (engine.Output, error) {
	timeout := h.Timeout
	if timeout <= 0 {
		timeout = 15 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, h.Bin, h.args()...)
	cmd.Env = h.childEnv()
	cmd.Stdin = strings.NewReader(TaskText(in) + screenshotNote)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	// Its own process group, so a cancel or timeout stops the browser and any
	// shell it started, not just the CLI.
	killGroupOnCancel(cmd)
	cmd.WaitDelay = 5 * time.Second

	err := cmd.Run()
	text := clean(stdout.String())
	if err != nil {
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return engine.Output{}, engine.Permanent(fmt.Errorf("hermes timed out after %s%s", timeout, tail(stderr.String())))
		case ctx.Err() != nil:
			return engine.Output{}, ctx.Err()
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) && exitErr.ExitCode() == 2 {
			// argparse / configuration refusal: retrying the same command won't help.
			return engine.Output{}, engine.Permanent(fmt.Errorf("hermes refused the command (exit 2)%s", tail(stderr.String())))
		}
		return engine.Output{}, fmt.Errorf("hermes failed: %v%s", err, tail(stderr.String()))
	}
	if text == "" {
		return engine.Output{}, fmt.Errorf("hermes returned no answer%s", tail(stderr.String()))
	}
	limit := h.MaxOutputChars
	if limit <= 0 {
		limit = 20_000
	}
	if len(text) > limit {
		text = text[:limit] + "\n…[cut]"
	}
	return engine.Output{Text: text}, nil
}

func clean(s string) string {
	return strings.TrimSpace(ansiPattern.ReplaceAllString(strings.ReplaceAll(s, "\r\n", "\n"), ""))
}

// tail is the last few lines of stderr, for an error message.
func tail(s string) string {
	s = clean(s)
	if s == "" {
		return ""
	}
	lines := strings.Split(s, "\n")
	if len(lines) > 6 {
		lines = lines[len(lines)-6:]
	}
	out := strings.Join(lines, "\n")
	if len(out) > 1500 {
		out = out[len(out)-1500:]
	}
	return ": " + out
}

func currentUser() string {
	for _, k := range []string{"USER", "LOGNAME"} {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Base(home)
	}
	return ""
}
