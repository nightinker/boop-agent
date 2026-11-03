# Web app testing (headless browser)

Boop can test web apps end to end: open pages, click through flows, fill
forms, check text and elements, call API endpoints, take a screenshot per
step, and collect console and network errors. It sends back a pass/fail
report and attaches the screenshots that matter. It can also report GitHub CI
status and run a repo's own test scripts next to the browser results.

It runs a **throwaway headless Chromium** (Patchright) on whatever machine
Boop is running on, so it works on the Linux server while your Mac is
offline. It's a separate thing from **Local browser use**, which drives your
own visible Chrome profile and only exists on the Mac.

## Using it

Text Boop something like:

> Test staging.example.com: a monthly user upgrading to lifetime sees the
> lifetime offer, a guest gets a 409 from the upgrade API, and the privacy page
> says "we never sell your data". Use the session staging-monthly.

The dispatcher hands the job to a sub-agent with the `webtest` integration.
The sub-agent turns your words into a plan, runs it, and replies with one
pass/fail line per scenario, failure details, and screenshots (failures
first). Ask it to save the plan ("save it as staging-smoke") and later just
say "run staging-smoke".

### Tools (sub-agent)

| Tool | What it does |
| --- | --- |
| `run_browser_test` | Runs a plan (YAML/JSON, or `planName` of a saved one) and returns the report. |
| `browser_check` | Quick read-only check of one URL: expected / absent texts, errors, screenshot. |
| `save_test_session` | Runs a login plan and saves the cookies/local storage under a name. |
| `list_test_sessions` / `delete_test_session` | Manage saved sessions. |
| `save_test_plan` / `list_test_plans` | Save and show reusable plans. |
| `ci_status` | GitHub checks for a PR, branch or commit through `gh` (read-only), with the tail of failed logs. |
| `run_repo_tests` | Runs a repo's `test`/`lint`/`typecheck`/`e2e`… script from its `package.json` in a checkout under your home folder. |
| `webtest_setup` | Says whether the browser works here, and with `install: true` downloads it. |

### Plan format

```yaml
name: Staging smoke
baseUrl: https://staging.example.com   # relative URLs resolve against this
session: staging-monthly               # optional saved login, per scenario overridable
device: iphone                         # optional: iphone, pixel, ipad, laptop, desktop
screenshots: each                      # each (default) | failures | none
stopOnFailure: true                    # stop a scenario at its first failed step
timeoutMs: 15000                       # default per-step timeout
scenarios:
  - name: Monthly user sees the lifetime offer
    steps:
      - goto: /account/subscription
      - click: { role: button, name: Upgrade }
      - expectText: Lifetime
      - screenshot: offer
  - name: Guest gets 409
    session: null                      # start logged out
    steps:
      - request: { method: POST, url: /api/subscription/upgrade, status: 409 }
  - name: Privacy page copy
    session: null
    steps:
      - goto: /privacy
      - expectText: we never sell your data
      - expectText: { text: Lorem ipsum, absent: true }
checks:                                # optional, reported next to the browser results
  ci:
    - { repo: acme/app, branch: main } # or pr: 123, or commit: abc1234
  suites:
    - { cwd: ~/Sites/app, script: test }
```

Each step has exactly one action, plus optional `name`, `optional: true` (a
failure is reported but doesn't fail the scenario), `destructive: true` and
`timeoutMs`:

| Action | Value |
| --- | --- |
| `goto` | URL or path. Fails on HTTP 4xx/5xx. |
| `click`, `hover`, `expectVisible`, `expectHidden` | a target |
| `fill` | `{ <target>, value: "…" }` or `{ <target>, secret: NAME }` |
| `select` | `{ <target>, value }` (value or visible label) |
| `check` | target, or `{ <target>, checked: false }` |
| `press` | key (`Enter`), or `{ key, <target> }` |
| `waitFor` | target, or `{ <target>, state: hidden }` |
| `wait` | milliseconds (max 60000) |
| `expectText` | text, or `{ text, in: target, absent: true }`. Case and whitespace insensitive. |
| `expectUrl` | substring, or `{ matches: regex }` |
| `expectTitle` | substring |
| `request` | `{ method, url, status: 409 or [200, 204], bodyContains, body, headers, secretHeaders: { Authorization: NAME } }`. Uses the session's cookies. Without `status`, any 4xx/5xx fails. |
| `screenshot` | label, or `{ label, fullPage: true }` |

A **target** is a CSS/Playwright selector string (`"#email"`,
`"text=Sign in"`), or one of `{ role: button, name: Save }`, `{ text: … }`,
`{ label: Email }`, `{ placeholder: … }`, `{ testId: … }`, each with optional
`exact: true` and `nth: 0`.

## Logins and credentials

Passwords never go through chat, plans, logs or reports.

- **Secret names in plans.** `fill: { label: Password, secret: WEBTEST_SITE_PASSWORD }`.
  On the Mac the value comes from Boop's secret store (ask Boop to
  `request_secret` it; you type it on the entry page). On the server, which has
  no secret store, set it as an environment variable named `WEBTEST_*` in the
  server's environment (e.g. its `.env.local`). Only `WEBTEST_*` names are
  read from the environment, so a plan can't type Boop's own keys into a page.
- **Saved sessions.** Run a login plan once with `save_test_session`; Boop keeps
  the browser's cookies and local storage at
  `~/.config/boop/webtest/sessions/<name>.json` (mode 600). Later plans say
  `session: <name>` and need no credentials. You can also copy a Playwright
  `storageState` file there yourself. Sessions are per machine: one saved on
  the Mac isn't on the server.

Every value a run used, and every value in the secret store, is replaced with
`[REDACTED:NAME]` in the report, even if the page echoes it back. Network
errors are listed without query strings. Screenshots show what the page
shows, so password fields stay masked but anything else on screen is visible.

## Safety

- **Staging by default.** Hosts with a label like `staging`, `stage`, `dev`,
  `preview`, `qa`, `test`, `uat` or `sandbox` count as non-production, and so
  do localhost and private IPs. Everything else is **production**. Tune it with
  `BOOP_WEBTEST_NONPROD_HOSTS` and `BOOP_WEBTEST_PRODUCTION_HOSTS`
  (comma-separated, suffix match; production wins). `BOOP_WEBTEST_DEFAULT_BASE_URL`
  is used when a plan has no `baseUrl`.
- **No destructive steps on production.** Steps that look like paying,
  buying, upgrading, subscribing, deleting, cancelling or closing an account,
  fills of card fields, any non-GET `request`, and steps marked
  `destructive: true` are destructive. If a plan touches production and has
  one, the whole run is refused before a browser starts. A staging page that
  redirects to production is caught too: the step is refused and not run.
  The sub-agent may only pass `confirmProductionDestructive: true` after you
  explicitly confirmed those exact actions.
- Each run gets a fresh browser context: no downloads, no shared profile.
  At most two runs at once per machine; a run stops after 15 minutes.
- `run_repo_tests` only runs scripts named like test/lint/check/e2e/typecheck/ci
  from a `package.json` under your home folder, without a shell. `ci_status`
  only uses read-only `gh` commands.

## Setup

**Mac:** `npm run webtest:install` once (or ask Boop to run `webtest_setup`
with install). If you already use Local browser use, the same Patchright
Chromium download works.

**Linux server**, in the Boop checkout as the user Boop runs as:

```bash
npm run webtest:install                     # downloads Chromium (~150 MB)
sudo npx patchright install-deps chromium   # once: system libraries Chromium needs
```

For CI status, install the GitHub CLI and log in (`gh auth login`), or set
`GH_TOKEN` in the server's environment.

**Docker:** build with `docker compose build --build-arg BOOP_WEBTEST_BROWSER=1`.
Saved sessions and plans live in `/home/node/.config/boop/webtest`; mount a
volume there if they should survive rebuilds.

If the browser isn't installed, test runs don't fail mysteriously: the report
says "COULDN'T RUN (browser unavailable)" with these setup steps, and CI/suite
checks in the plan still run.

Other settings: `BOOP_WEBTEST_EXECUTABLE_PATH` points at a specific
Chrome/Chromium binary; `BOOP_WEBTEST_DIR` moves the sessions/plans folder;
`BOOP_WEBTEST_DISABLED=1` turns the integration off.

## Where things are

- Screenshots and `report.json` per run: `$TMPDIR/boop-webtest/run-*/` (last 20 runs kept).
- Code: `server/webtest/` (`plan.ts` format, `safety.ts` rules, `runner.ts`,
  `driver.ts` Patchright, `checks.ts` CI/suites, `storage.ts` sessions/credentials,
  `tools.ts`), registered by `server/integrations/webtest-loader.ts`.
- Tests: `test/webtest.test.ts`. The real-browser test runs only where
  Chromium is installed and is skipped otherwise.
