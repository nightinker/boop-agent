# Orchestrator sidecar (Go)

A small Go service that sits next to Boop. You give it a task (or a ready-made
plan); it breaks the task into a DAG of steps and runs them, some with
Go-native agents and some with Boop's own TypeScript sub-agents (the same path
`spawn_agent` uses).

Standard library only. The module path `boop-agent/orchestrator` is a placeholder.

**Milestone 2 status:** planner, engine, bridge and HTTP API. Runs live in
memory and are **lost on restart**; trace persistence is the next milestone.

## Run it

```sh
cd orchestrator-go
go test -race ./...
go run ./cmd/orchestrator            # listens on 127.0.0.1:3460
```

| Setting | Default | |
|---|---|---|
| `-addr` / `ORCHESTRATOR_ADDR` | `127.0.0.1:3460` | Won't bind past loopback unless `ORCHESTRATOR_TOKEN` is set. |
| `-boop-url` / `BOOP_URL` | `http://127.0.0.1:$PORT` (3456) | Boop's server, for the bridge. |
| `-max-tokens` | `200000` | Token budget per run (0 = unlimited). |
| `-max-parallel` | `2` | Tasks running at once per run. |
| `-max-attempts` | `3` | Tries per task before it fails. |
| `ANTHROPIC_API_KEY` | – | Turns on the planner and the `llm` agent. Without it you can still submit plans. |
| `ORCHESTRATOR_MODEL` | `claude-opus-5-5` | Model for the planner and `llm` agent. |
| `ORCHESTRATOR_TOKEN` | – | If set, every `/v1` call needs `Authorization: Bearer <token>`. |

## API

```sh
# Plan only (nothing runs)
curl -s localhost:3460/v1/plan -d '{"task":"Summarise unpaid bills in my email this week"}'

# Plan and run
curl -s localhost:3460/v1/runs -d '{"task":"…", "max_tokens": 60000}'

# Run a plan you wrote
curl -s localhost:3460/v1/runs -d '{"plan":{"goal":"…","tasks":[
  {"id":"mail","agent":"boop","input":"Find unpaid bills","integrations":["gmail"],"cost_hint":"med",
   "scout":{"narrow":["subject:invoice","last 7 days"]}},
  {"id":"brief","agent":"llm","input":"Write a 3-line brief","depends_on":["mail"],"cost_hint":"low"}]}}'

curl -s localhost:3460/v1/runs/<id>            # status
curl -s -X POST localhost:3460/v1/runs/<id>/cancel
curl -s localhost:3460/v1/runs                 # all runs in memory
curl -s localhost:3460/v1/agents               # agents + Boop's integrations
```

`POST /v1/runs` answers `202` with the run. A plan that fails validation gets
`422` with a `problems` list. Asking for a task with no planner configured gets `503`.

## Plans

Each task has `id`, `agent`, `input`, `cost_hint` (`low` / `med` / `high`),
and optionally `title`, `depends_on`, `integrations` (for `boop` only) and
`scout.narrow`: up to 8 hints that keep the agent's search narrow (which
account, sender, folder, site or date range to check first). Validation
checks ids, agents, integrations, cost hints, dependencies and cycles, and a
limit of 12 tasks.

The planner asks the model for JSON, validates it, and if it's wrong sends the
problems back for one more try.

## Agents

| Agent | What it does |
|---|---|
| `boop` | Bridge: runs the task as a Boop sub-agent via `POST /orchestrator/spawn` on Boop's server, with the task's integrations. Scout hints and earlier steps' outputs go into the task text. Cancelling drops the request and Boop aborts the sub-agent. |
| `llm` | The model, no tools: summarise, compare, draft over earlier outputs. |
| `join` | Joins the outputs of its dependencies verbatim. No model call. |
| `echo` | Returns its input; for testing only (not offered to the planner). |

## How a run is scheduled

- Up to `max_parallel` (default 2) ready tasks run at once, cheapest first.
- **Token budget:** before a task starts, its cost-hint estimate is reserved
  (low 2k, med 8k, high 24k). A task waits if running tasks hold the room it
  needs, and is **SKIPPED** if it can never fit. When an agent reports real
  usage it's charged that, otherwise the estimate. (Boop's sub-agents don't
  report usage over the bridge yet, so they're charged the estimate.)
- **Retries:** failures are retried with exponential backoff (500ms, doubling,
  max 10s). Permanent failures (bad request, spend limit, refusal, cancelled in
  Boop) aren't retried.
- **BLOCKED vs SKIPPED:** a task is BLOCKED when something it depends on
  failed, was blocked or was cancelled (the run then FAILS). It's SKIPPED when
  it was deliberately not run: no budget, a skipped dependency, or a
  short-circuit (an agent said the goal is already met). Skips don't fail the run.
- **Cancel:** running tasks get their context cancelled; pending ones become CANCELLED.
