// Command orchestrator runs Boop's orchestrator sidecar: an HTTP API that
// plans a task into a DAG and runs it with Go-native agents and Boop's own
// sub-agents. Runs live in memory and are lost on restart.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"boop-agent/orchestrator/agents"
	"boop-agent/orchestrator/api"
	"boop-agent/orchestrator/engine"
	"boop-agent/orchestrator/llm"
	"boop-agent/orchestrator/merge"
	"boop-agent/orchestrator/plan"
)

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func run() error {
	defaultBoop := agents.DefaultBoopURL
	if port := strings.TrimSpace(os.Getenv("PORT")); port != "" {
		defaultBoop = "http://127.0.0.1:" + port
	}
	addr := flag.String("addr", envOr("ORCHESTRATOR_ADDR", "127.0.0.1:3460"), "address to listen on")
	boopURL := flag.String("boop-url", envOr("BOOP_URL", defaultBoop), "Boop server URL (for the bridge)")
	maxTokens := flag.Int("max-tokens", 200_000, "default token budget per run (0 = unlimited)")
	maxParallel := flag.Int("max-parallel", 2, "default tasks running at once per run")
	maxAttempts := flag.Int("max-attempts", 3, "tries per task before it fails")
	flag.Parse()

	token := os.Getenv("ORCHESTRATOR_TOKEN")
	if err := checkExposure(*addr); err != nil {
		return err
	}

	boop := &agents.Boop{BaseURL: *boopURL}
	registered := []engine.Agent{boop, agents.Join{}, agents.Echo{}}

	var planner engine.Planner
	var merger engine.Merger
	provider, err := llm.NewAnthropicFromEnv()
	if err != nil {
		log.Printf("planner, llm agent and result merger disabled: %v (plans can still be submitted; results are joined without a model)", err)
	} else {
		merger = merge.LLM{Provider: provider}
		registered = append(registered, agents.LLM{Provider: provider})
		specs := make([]plan.AgentSpec, 0, len(registered))
		for _, a := range registered {
			if a.Spec().Name != "echo" { // keep the test agent out of real plans
				specs = append(specs, a.Spec())
			}
		}
		planner = &plan.Planner{LLM: provider, Agents: specs, Integrations: boop.Integrations}
	}

	m := engine.NewManager(engine.Config{
		Agents:       registered,
		Planner:      planner,
		Merger:       merger,
		Integrations: boop.Integrations,
		Options:      engine.Options{MaxTokens: *maxTokens, MaxParallel: *maxParallel, MaxAttempts: *maxAttempts},
	})
	srv := &http.Server{
		Addr:              *addr,
		Handler:           (&api.Server{Manager: m, Token: token}).Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	errc := make(chan error, 1)
	go func() {
		log.Printf("orchestrator listening on %s (boop at %s)", *addr, *boopURL)
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
	}
	log.Print("shutting down; in-flight runs are cancelled")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
	return m.Shutdown(shutdownCtx)
}

// checkExposure refuses to listen anywhere but loopback, token or not: the
// API can make Boop's sub-agents act on the owner's accounts, and only Boop
// on the same Mac should reach it. ORCHESTRATOR_TOKEN adds a second check on
// top, for other local processes.
func checkExposure(addr string) error {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("bad -addr %q: %w", addr, err)
	}
	if host == "localhost" {
		return nil
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		return nil
	}
	return fmt.Errorf("refusing to listen on %s: the orchestrator only binds to localhost (use 127.0.0.1:<port>)", addr)
}
