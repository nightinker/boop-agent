# Orchestrator sidecar (Go)

A small Go service that sits next to Boop. You give it a task (or a ready-made
plan); it breaks the task into a DAG of steps and runs them, some with
Go-native agents and some with Boop's own TypeScript sub-agents (the same path
`spawn_agent` uses).

Standard library only. The module path `boop-agent/orchestrator` is a placeholder.

**Status:** Milestone 2 (planner, engine, bridge) and Milestone 3 (Boop ⇄
sidecar HTTP API, result merger). Runs live in memory and are **lost on
restart**; saved run traces are next.

## Run it

```sh
cd orchestrator-go
go test -race ./...
go run ./cmd/orchestrator            # listens on 127.0.0.1:3460
```

| Setting | Default | |
|---|---|---|
| `-addr` / `ORCHESTRATOR_ADDR` | `127.0.0.1:3460` | Localhost only: any other address is refused, token or not. |
| `-boop-url` / `BOOP_URL` | `http://127.0.0.1:$PORT` (3456) | Boop's server, for the bridge and for model calls. |
| `-max-tokens` | `200000` | Token budget per run (0 = unlimited). |
| `-max-parallel` | `2` | Tasks running at once per run. |
| `-max-attempts` | `3` | Tries per task before it fails. |
| `ANTHROPIC_API_KEY` | – | Optional override. The planner, the `llm` agent and the result merger are always on and, by default, run their model calls through Boop (see [Model calls](#model-calls)). With this set they call the Anthropic API directly instead. |
| `ORCHESTRATOR_MODEL` | `claude-opus-5-5` | Model for the planner, `llm` agent and merger when `ANTHROPIC_API_KEY` is set. Through Boop, Boop's own model setting applies. |
| `ORCHESTRATOR_TOKEN` | – | If set, every `/v1` call needs `Authorization: Bearer <token>` (Boop sends it when the same variable is set for Boop). |

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

curl -s localhost:3460/v1/runs/<id>                  # status + every step's state and output
curl -s 'localhost:3460/v1/runs/<id>?wait=30'        # same, but waits up to 30s for the run to finish
curl -s 'localhost:3460/v1/runs/<id>/result?wait=30' # the merged final answer
curl -s -X POST localhost:3460/v1/runs/<id>/cancel
curl -s localhost:3460/v1/runs                       # all runs in memory
curl -s localhost:3460/v1/agents                     # agents + Boop's integrations
```

`POST /v1/runs` takes exactly one of `task` or `plan`, plus optional
`max_tokens` (1–2,000,000), `max_parallel` (1–8) and `conversation_id` (Boop
sub-agents spawned by the run are tied to that conversation). It answers
`202` with the run.

Errors are JSON `{"error": "..."}`:

| Status | When |
|---|---|
| `400` | Empty or malformed body, unknown fields, both/neither of `task` and `plan`, out-of-range limits, a task over 20,000 characters, a bad run id. |
| `401` | `ORCHESTRATOR_TOKEN` is set and the bearer token is missing or wrong. |
| `404` | No such run (runs are lost when the sidecar restarts). |
| `409` | Cancelling a run that already finished (the body has the run). |
| `413` | Body over 1 MB. |
| `422` | The plan fails validation; the body has a `problems` list. |
| `503` | A `task` was sent but no planner is configured (only in tests: the real binary always has one), or the sidecar is shutting down. |

`GET /v1/runs/{id}/result` answers `202` with `"done": false` while the run is
going and `200` once it's finished:

```json
{"id":"run_…","state":"SUCCEEDED","done":true,"tokens_used":14200,"token_budget":60000,
 "result":{"answer":"…","method":"llm","sources":["https://…"],
           "incomplete":[{"id":"cal","state":"FAILED","note":"…"}],"tokens":1800}}
```

`?wait=N` (up to 60 seconds) on a run's status or result holds the request
until the run finishes or N seconds pass, so callers don't need to poll fast.

`GET /healthz` says whether the planner and merger are on and where their
model calls go: `{"ok":true,"planner":true,"merger":true,"llm":"boop"}`
(`"anthropic"` when `ANTHROPIC_API_KEY` is set).

## Model calls

The planner, the `llm` agent and the result merger don't need an API key. By
default each model call goes back to Boop as `POST /orchestrator/complete`
(`{"system", "messages", "max_tokens", "purpose"}` → `{"text", "usage"}`), and
Boop runs it through its own model runtime: the Claude Agent SDK, signed in
with the Claude account already logged in on the Mac (or whichever runtime and
model Boop is set to). The call has no tools, and its usage is recorded in
Boop's usage log as `orchestrator`.

- **Token budget:** the tokens Boop reports (fresh input + output) are charged
  to the run like any step. Planning counts too: what the planner used is
  added to `tokens_used` before the first step starts. The runtime can't cap
  output, so `max_tokens` (sized to what's left of the budget) is passed to
  the model as an instruction.
- **Failures:** if planning fails (Boop unreachable, model error, usage limit,
  a bad plan twice), the run doesn't fail: it goes ahead with a one-step plan
  that gives the whole task to one `boop` sub-agent, and the result says so in
  `plan_fallback`. If the merge fails, results are joined without the model
  (`method: "fallback"`, see below).
- **Override:** with `ANTHROPIC_API_KEY` set (Boop passes it from its secret
  store when one is saved), the sidecar calls the Anthropic Messages API
  itself and never uses the bridge for model calls.

## Result merger (report agent)

Once every step has settled, the run is `MERGING` while the report agent
writes the final answer from **all** step outputs (not just the last step's),
using Claude:

- **Sources:** every URL in any step's output is collected and kept verbatim.
  The model is told to copy them exactly, and any URL missing from its answer
  is added under a `Sources:` list afterwards, so none is lost or rewritten.
- **Failed, blocked and skipped steps** are shown to the model with their
  reason; it answers with what it has and says what's missing. They're also
  listed in `result.incomplete`. A run with failures still gets a merged answer.
- **Token budget:** the merge only uses what's left of the run's budget. It's
  skipped if fewer than 2,000 tokens remain; otherwise the answer gets up to a
  quarter of what's left (max 4,000) and long step outputs are cut to fit the
  rest. Its real usage is added to `tokens_used`.
- **Fallbacks** (`method`): `single` for one-step plans (no model call),
  `fallback` when there's no merger, not enough budget, the merge failed (e.g. Boop's runtime errored) or
  the run was cancelled (the final steps' outputs joined, a "Not completed"
  list, and the sources; `merge_error` says why), `none` when no step
  produced anything. The fallback skips steps that succeeded with an empty
  output; if every final step is empty it uses the earlier steps' outputs.
- **Order:** steps, sources and `incomplete` are always in plan order, not the
  order steps happened to finish, so the same results give the same answer.
- **Never crashes the run:** a merger that errors, panics or returns nothing
  falls back to the joined answer.

## Boop side

- `server/orchestrator-client.ts` talks to this API: submit, status,
  long-polled result, cancel. It only accepts a localhost `ORCHESTRATOR_URL`
  (default `http://127.0.0.1:3460`) and sends `ORCHESTRATOR_TOKEN` if set.
- `server/orchestrator-sidecar.ts` runs it: on startup Boop builds the binary
  into `data/orchestrator/bin/` when it's missing or the Go source changed,
  starts it on `127.0.0.1:3460` (or `ORCHESTRATOR_URL`'s port), logs its
  output to `data/orchestrator/orchestrator.log`, health-checks it every 15s,
  restarts it with backoff if it dies or hangs, and stops it on shutdown. If a
  sidecar is already answering on the port, Boop uses it instead. Set
  `ORCHESTRATOR_SIDECAR=off` to run it yourself.
- **The sidecar is optional:** no Go, a failed build or a crash just means
  Boop runs without the orchestrator tools, with a log line saying why.
- The planner and merger work with no key: their model calls come back to
  Boop's `POST /orchestrator/complete` (`server/orchestrator-bridge.ts`,
  `server/orchestrator-llm.ts`), which runs them through Boop's own Claude
  runtime. `ANTHROPIC_API_KEY` is an optional override: it comes only from
  Boop's secret store (Keychain) and is put in the sidecar's environment at
  spawn time; the sidecar gets a minimal environment, not Boop's. Saving or
  removing the key restarts the sidecar so it switches over.
- The dispatcher always has `orchestrator_health` ("is the orchestrator
  working?"): live status, port, last health check, whether the planner and
  merger are on and which way they call the model (Boop's runtime or the API
  key override), whether the key is stored, and a self-test that runs a two-step `echo` plan and checks the
  merged result. Also `GET /orchestrator/sidecar` and
  `POST /orchestrator/sidecar/self-test` on Boop's server.
- While the sidecar answers its health check, the dispatcher gets three
  tools: `run_orchestration` (submit a task, wait for the merged answer),
  `orchestration_status` and `cancel_orchestration`. Runs are tied to the
  conversation they came from.
- The dashboard's **Orchestrator** tab shows the sidecar at a glance: running,
  starting, restarting, down or not configured; uptime, restarts and the next
  restart's backoff; the planner and merger and which model path they use;
  whether the optional `ANTHROPIC_API_KEY` override is stored (never its value);
  and the last 40 lines of `orchestrator.log`. Below that, the recent runs and,
  for the one you pick, its plan as a dependency graph and a timeline: each
  step's status, agent, duration, output and the merged result. It polls
  every 2s while a run is going. The page reads Boop's
  `GET /orchestrator/dashboard` and `GET /orchestrator/dashboard/runs/{id}`
  (local only, `server/orchestrator-dashboard.ts`), which call `GET /v1/runs`
  and `GET /v1/runs/{id}` here, so the browser never talks to the sidecar. If
  the sidecar is down the page says "Orchestrator not running"; log lines and
  run text pass through Boop's secret scrubber first.

## Plans

Each task has `id`, `agent`, `input`, `cost_hint` (`low` / `med` / `high`),
and optionally `title`, `depends_on`, `integrations` (for `boop` only) and
`scout.narrow`: up to 8 hints that keep the agent's search narrow (which
account, sender, folder, site or date range to check first). Validation
checks ids, agents, integrations, cost hints, dependencies and cycles, and a
limit of 12 tasks.

The planner asks the model for JSON, validates it, and if it's wrong sends the
problems back for one more try. If that still fails, or the model can't be
reached, the run uses a one-step `boop` plan instead (see [Model calls](#model-calls)).

## Agents

| Agent | What it does |
|---|---|
| `boop` | Bridge: runs the task as a Boop sub-agent via `POST /orchestrator/spawn` on Boop's server, with the task's integrations. Scout hints and earlier steps' outputs go into the task text. Cancelling drops the request and Boop aborts the sub-agent. |
| `llm` | The model, no tools: summarise, compare, draft over earlier outputs. |
| `join` | Joins the outputs of its dependencies verbatim. No model call. |
| `echo` | Returns its input; for testing only (not offered to the planner). |
| `hermes` | [Hermes Agent](https://github.com/NousResearch/hermes-agent) on this machine, for hands-on testing: a real headless browser (navigate, click, fill forms, screenshot and look at the page), a shell for test suites, and the web. Offered only when `hermes` is installed (see [Hermes agent](#hermes-agent)). |

## Hermes agent

`agents/hermes.go` runs a task with Hermes Agent's one-shot CLI,
`hermes chat --query-file -` (the task goes in on stdin, never as an
argument), and returns what it answers. It is offered to the planner only on
a machine where `hermes` is found, so **the Mac and the Linux server each offer
it when Hermes is installed there**: whichever copy of Boop is active runs
browser and screenshot tasks on its own machine. Without Hermes the agent is
simply not offered (`hermes agent off` in the log).

- **Model:** your Claude Pro/Max subscription, through Hermes' official
  [`claude-subscription-directsdk`](https://github.com/NousResearch/hermes-official-plugins/tree/main/claude-subscription-directsdk)
  plugin, which drives the `claude` CLI (the same Agent SDK login Boop uses).
  No API key: the agent strips `ANTHROPIC_API_KEY` and endpoint overrides
  from Hermes' environment, since that provider refuses them, and adds
  `USER`/`LOGNAME`, which the `claude` CLI needs to see its login under
  launchd or systemd. Turns count against the subscription's allowance.
- **Tools:** `browser,vision,web,terminal,file`, **auto-approved** (`--yolo`):
  a one-shot run has nobody to approve a command. Anything it decides to run,
  runs, as the user the sidecar runs as. Narrow it with
  `ORCHESTRATOR_HERMES_TOOLSETS` (e.g. `browser,vision,web`) or set
  `ORCHESTRATOR_HERMES_YOLO=off` (shell commands then wait for an approval and
  time out).
- **Screenshots:** Hermes' local Chromium is headless and works on a server
  with no desktop. The task text asks it to end its answer with a
  `Screenshots:` list of absolute file paths on that machine.
- **Limits:** 60 turns and 15 minutes per task by default. A timeout or cancel
  kills Hermes' whole process group (its browser and any shell it started).
  Exit 2 (Hermes refused the command or its config) and a timeout are not
  retried; other failures are. The answer passed on is capped at 20,000
  characters. Cost hint: `high`.
- `hermes chat` runs the turn in Hermes' own gateway (it starts one if none is
  running). The CLI is what the orchestrator waits for; if the sidecar is
  killed mid-task, the turn may finish in the gateway on its own.

| Setting | Default | |
|---|---|---|
| `HERMES_BIN` | `hermes` on PATH, then `~/.local/bin`, `~/.hermes/bin`, `/usr/local/bin`, `/opt/homebrew/bin` | Where Hermes is. |
| `ORCHESTRATOR_HERMES` | on | `off` never offers the agent. |
| `ORCHESTRATOR_HERMES_PROVIDER` | `claude-subscription-directsdk-experimental` | Set it empty to use the provider from `hermes model`. |
| `ORCHESTRATOR_HERMES_MODEL` | `sonnet` | `opus` for harder runs; empty uses the provider's default. |
| `ORCHESTRATOR_HERMES_TOOLSETS` | `browser,vision,web,terminal,file` | Empty uses Hermes' own toolsets. |
| `ORCHESTRATOR_HERMES_YOLO` | on | `off` keeps Hermes' approvals. |
| `ORCHESTRATOR_HERMES_MAX_TURNS` | `60` | |
| `ORCHESTRATOR_HERMES_TIMEOUT` | `15m` | Go duration. |

Boop passes these (and `CLAUDE_CONFIG_DIR`,
`CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND`/`_CONFIG_DIR`) through to the
sidecar's otherwise minimal environment (`HERMES_ENV_KEYS` in
`server/orchestrator-sidecar.ts`).

### Setting it up (once per machine: the Mac and/or the Linux server)

Run these as the user Boop runs as:

```sh
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash   # Hermes (bundles its Chromium)
npm install -g @anthropic-ai/claude-code && claude auth login         # if `claude` isn't logged in yet
hermes plugins install claude-subscription-directsdk                  # Claude subscription provider
hermes chat --provider claude-subscription-directsdk-experimental --model sonnet -q "Say hi"   # smoke test
```

The server also needs Go (1.22+) so Boop can build the sidecar; without it the
orchestrator is off there, Hermes included. Restart Boop afterwards: the
sidecar logs `hermes agent on (...)`, and `GET /v1/agents` lists `hermes`.

## How a run is scheduled

- Up to `max_parallel` (default 2) ready tasks run at once, cheapest first.
- **Token budget:** before a task starts, its cost-hint estimate is reserved
  (low 2k, med 8k, high 24k). A task waits if running tasks hold the room it
  needs, and is **SKIPPED** if it can never fit. When an agent reports real
  usage it's charged that, otherwise the estimate. Boop's sub-agents report
  their usage over the bridge; they're charged fresh input + output tokens
  (cache reads/writes aren't charged until token calibration).
- **Retries:** failures are retried with exponential backoff (500ms, doubling,
  max 10s). Permanent failures (bad request, spend limit, refusal, cancelled in
  Boop) aren't retried.
- **BLOCKED vs SKIPPED:** a task is BLOCKED when something it depends on
  failed, was blocked or was cancelled (the run then FAILS). It's SKIPPED when
  it was deliberately not run: no budget, a skipped dependency, or a
  short-circuit (an agent said the goal is already met). Skips don't fail the run.
- **Cancel:** running tasks get their context cancelled; pending ones become CANCELLED.
