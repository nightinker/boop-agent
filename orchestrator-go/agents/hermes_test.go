package agents

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"boop-agent/orchestrator/engine"
	"boop-agent/orchestrator/plan"
)

// fakeHermes writes a stand-in `hermes` that records how it was called and
// behaves as FAKE_MODE says: ok (answers with colour codes), empty, exit2,
// exit1, or hang (starts a child that would outlive the CLI if not killed).
func fakeHermes(t *testing.T) (bin, dir string) {
	t.Helper()
	dir = t.TempDir()
	bin = filepath.Join(dir, "hermes")
	script := `#!/bin/sh
d="$(dirname "$0")"
printf '%s\n' "$@" > "$d/args"
cat > "$d/stdin"
env > "$d/env"
case "$FAKE_MODE" in
  empty) exit 0 ;;
  exit2) echo "usage: hermes chat [-q QUERY]" >&2; exit 2 ;;
  exit1) echo "gateway not reachable" >&2; exit 1 ;;
  hang) sleep 30 & echo $! > "$d/child"; wait ;;
  *) printf '\033[1m\342\230\244 Checked the page.\033[0m\r\nAll 3 checks passed.\nScreenshots:\n/tmp/shot-1.png\n' ;;
esac
`
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, dir
}

func hermesInput(text string) engine.Input {
	return engine.Input{RunID: "run_1", Task: plan.Task{ID: "qa", Agent: "hermes", Input: text}}
}

func readLines(t *testing.T, path string) []string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimRight(string(b), "\n"), "\n")
}

func TestHermesRunsOneShotWithProviderToolsetsAndYolo(t *testing.T) {
	bin, dir := fakeHermes(t)
	h := &Hermes{Bin: bin, Provider: HermesDefaultProvider, Model: "sonnet", Toolsets: HermesDefaultToolsets, Yolo: true,
		Env: []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "ANTHROPIC_API_KEY=sk-secret", "ANTHROPIC_BASE_URL=https://x"}}

	out, err := h.Run(context.Background(), hermesInput("Open https://example.com and check the title"))
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"chat", "--query-file", "-", "--provider", HermesDefaultProvider, "--model", "sonnet",
		"--toolsets", HermesDefaultToolsets, "--max-turns", "60", "--yolo"}
	if got := readLines(t, filepath.Join(dir, "args")); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("args = %q, want %q", got, want)
	}
	stdin, _ := os.ReadFile(filepath.Join(dir, "stdin"))
	if !strings.Contains(string(stdin), "Open https://example.com and check the title") || !strings.Contains(string(stdin), "Screenshots:") {
		t.Fatalf("the task (and the screenshot note) go in on stdin, never as an argument: %q", stdin)
	}
	env, _ := os.ReadFile(filepath.Join(dir, "env"))
	if strings.Contains(string(env), "sk-secret") || strings.Contains(string(env), "ANTHROPIC_BASE_URL") {
		t.Fatal("the subscription provider must never see an API key or endpoint override")
	}
	if !strings.Contains(string(env), "\nUSER=") && !strings.HasPrefix(string(env), "USER=") {
		t.Fatal("USER must be set: the claude CLI reports logged-out without it under launchd/systemd")
	}
	if strings.Contains(out.Text, "\x1b") || strings.Contains(out.Text, "\r") {
		t.Fatalf("colour codes and CRs are stripped: %q", out.Text)
	}
	if !strings.Contains(out.Text, "All 3 checks passed.") || !strings.Contains(out.Text, "/tmp/shot-1.png") {
		t.Fatalf("answer = %q", out.Text)
	}
}

func TestHermesLeavesProviderAndModelToItsConfigWhenEmpty(t *testing.T) {
	bin, dir := fakeHermes(t)
	h := &Hermes{Bin: bin, MaxTurns: 12, Env: []string{"PATH=" + os.Getenv("PATH")}}

	if _, err := h.Run(context.Background(), hermesInput("x")); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(readLines(t, filepath.Join(dir, "args")), " ")
	if got != "chat --query-file - --max-turns 12" {
		t.Fatalf("args = %q", got)
	}
}

func TestHermesFailures(t *testing.T) {
	cases := []struct {
		mode      string
		permanent bool
		contains  string
	}{
		{"exit2", true, "usage: hermes chat"},
		{"exit1", false, "gateway not reachable"},
		{"empty", false, "no answer"},
	}
	for _, c := range cases {
		t.Run(c.mode, func(t *testing.T) {
			bin, _ := fakeHermes(t)
			h := &Hermes{Bin: bin, Env: []string{"PATH=" + os.Getenv("PATH"), "FAKE_MODE=" + c.mode}}
			_, err := h.Run(context.Background(), hermesInput("x"))
			if err == nil {
				t.Fatal("want an error")
			}
			if engine.IsPermanent(err) != c.permanent {
				t.Fatalf("permanent = %v, want %v (%v)", engine.IsPermanent(err), c.permanent, err)
			}
			if !strings.Contains(err.Error(), c.contains) {
				t.Fatalf("error %q should carry %q", err, c.contains)
			}
		})
	}
}

func TestHermesTimeoutKillsTheWholeProcessGroup(t *testing.T) {
	bin, dir := fakeHermes(t)
	h := &Hermes{Bin: bin, Timeout: 700 * time.Millisecond, Env: []string{"PATH=" + os.Getenv("PATH"), "FAKE_MODE=hang"}}

	start := time.Now()
	_, err := h.Run(context.Background(), hermesInput("x"))
	if err == nil || !engine.IsPermanent(err) || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("want a permanent timeout, got %v", err)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatal("the run should end soon after the timeout")
	}
	pidText, err := os.ReadFile(filepath.Join(dir, "child"))
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(strings.TrimSpace(string(pidText)))
	time.Sleep(200 * time.Millisecond)
	if syscall.Kill(pid, 0) == nil {
		_ = syscall.Kill(pid, syscall.SIGKILL)
		t.Fatal("a process Hermes started (its browser, a shell) outlived the timeout")
	}
}

func TestHermesCancelReturnsTheContextError(t *testing.T) {
	bin, _ := fakeHermes(t)
	h := &Hermes{Bin: bin, Env: []string{"PATH=" + os.Getenv("PATH"), "FAKE_MODE=hang"}}
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(300*time.Millisecond, cancel)

	_, err := h.Run(ctx, hermesInput("x"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestHermesCapsALongAnswer(t *testing.T) {
	bin, _ := fakeHermes(t)
	h := &Hermes{Bin: bin, MaxOutputChars: 10, Env: []string{"PATH=" + os.Getenv("PATH")}}
	out, err := h.Run(context.Background(), hermesInput("x"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(out.Text, "…[cut]") || len(out.Text) > 10+len("\n…[cut]") {
		t.Fatalf("answer = %q", out.Text)
	}
}

func envMap(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestHermesFromEnv(t *testing.T) {
	bin, dir := fakeHermes(t)

	if h := HermesFromEnv(envMap(map[string]string{"HERMES_BIN": filepath.Join(dir, "missing"), "HOME": dir})); h != nil {
		t.Fatal("no hermes binary: no agent, so the planner never offers it")
	}
	if h := HermesFromEnv(envMap(map[string]string{"HERMES_BIN": bin, "ORCHESTRATOR_HERMES": "off"})); h != nil {
		t.Fatal("ORCHESTRATOR_HERMES=off turns it off")
	}

	h := HermesFromEnv(envMap(map[string]string{"HERMES_BIN": bin}))
	if h == nil || h.Bin != bin || h.Provider != HermesDefaultProvider || h.Model != HermesDefaultModel ||
		h.Toolsets != HermesDefaultToolsets || !h.Yolo {
		t.Fatalf("defaults = %+v", h)
	}

	h = HermesFromEnv(envMap(map[string]string{
		"HERMES_BIN": bin, "ORCHESTRATOR_HERMES_PROVIDER": "", "ORCHESTRATOR_HERMES_MODEL": "opus",
		"ORCHESTRATOR_HERMES_YOLO": "off", "ORCHESTRATOR_HERMES_MAX_TURNS": "20", "ORCHESTRATOR_HERMES_TIMEOUT": "5m",
	}))
	if h.Provider != "" || h.Model != "opus" || h.Yolo || h.MaxTurns != 20 || h.Timeout != 5*time.Minute {
		t.Fatalf("settings = %+v", h)
	}

	// Found in the installer's place under HOME when PATH doesn't have it.
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, ".local", "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	local := filepath.Join(home, ".local", "bin", "hermes")
	if err := os.Symlink(bin, local); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "/nonexistent")
	if got := FindHermes(func(k string) string { return map[string]string{"HOME": home}[k] }); got != local {
		t.Fatalf("FindHermes = %q, want %q", got, local)
	}
}

func TestHermesSpecIsOfferedForTesting(t *testing.T) {
	s := (&Hermes{}).Spec()
	if s.Name != "hermes" || s.UsesIntegrations || !strings.Contains(s.Description, "screenshot") {
		t.Fatalf("spec = %+v", s)
	}
}
