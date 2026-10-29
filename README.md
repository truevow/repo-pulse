# Repo Pulse

Repo Pulse syncs a public GitHub repository into Postgres and computes 15
collaboration metrics per ISO week or day: review latency, throughput,
review-load concentration, issue flow and commit spread. Four robust-statistics
detectors flag what is unusual. Claude then writes a short narrative over those
signals, with a root-cause hypothesis, a confidence score and an evidence chain.
The narrative is for an engineering manager who wants to know what changed in
how the team works and why.

The narrative is designed to be checkable, not just plausible:

- **Grounding.** Every evidence item is checked deterministically against a
  ledger of the numbers the service actually showed the model. Items that do
  not match are removed and reported.
- **Calibration.** Confidence is capped by documented rules about the
  evidence that survives.
- **Evals.** An eval suite with planted-cause fixtures regression-tests the
  prompt.

Metric, detector, grounding and calibration rules: [docs/metrics.md](docs/metrics.md).
Decisions, trade-offs and how this was built: [NOTES.md](NOTES.md).

## Quickstart (60 seconds)

Requires Node 22+ and Docker.

```bash
cp .env.example .env
# Edit .env:
#   ANTHROPIC_API_KEY  required for the narrative endpoint
#   GITHUB_TOKEN       required only for live sync (see "Live sync")
docker compose up -d db
npm install
npm run db:migrate
npm run demo:seed
npm run start:dev
```

`npm run demo:seed` loads a synthetic repository, `evalco/service-1`. It is the
`latency_spike` eval fixture: eight weeks, 205 PRs, 42 issues and 191 commits,
with first-review latency planted at 5x in the week of 2026-10-05. It needs no
GitHub token.

- `npm run demo:seed -- <case>` loads a different eval case instead. The cases
  are `control`, `reviewer_dropout`, `throughput_shift`, `concentration` and
  `commit_only`, and each loads under its own name (`evalco/service-<seed>`;
  the script prints the name and window).
- The fixtures reuse synthetic GitHub ids, so `demo:seed` first deletes every
  repository owned by `evalco`: only one case is loaded at a time. It refuses
  to load if another repository already holds those ids.
- `npm run db:seed` loads every snapshot in `seed/`. `seed/` is empty in this
  checkout, because no live sync has been run from it (see "Live sync"), so
  `db:seed` reports that and `demo:seed` is the way to load data.

Then, in another terminal:

```bash
curl -s 'http://localhost:3000/api/v1/repos/evalco/service-1/insights?from=2026-08-31&to=2026-10-26'
curl -s 'http://localhost:3000/api/v1/repos/evalco/service-1/narrative?from=2026-08-31&to=2026-10-26'
curl -s 'http://localhost:3000/api/v1/health'
```

The insights call returns 4 signals. The top one is a `high` robust outlier on
`time_to_first_review_p50_h`, 21.53 h against a typical 6.29 h. The first
narrative call is a cache miss, so it runs the model: 15 to 30 seconds, about
$0.06. Repeat calls return the stored narrative with `cached: true`.

To use the demo page, open <http://localhost:3000/>. Click "Use synthetic demo
repo", which fills in `evalco/service-1`, From 2026-08-31 and To 2026-10-26,
then click "Load insights" and "Generate narrative". The OpenAPI UI is at
<http://localhost:3000/docs>.

## Docker

The container runs the app, but the data has to be loaded from the host:
`seed/` is empty, and the image does not ship `eval/`, so `demo:seed` cannot
run inside it.

```bash
cp .env.example .env        # required: the host-side demo:seed needs DATABASE_URL
docker compose up --build -d
npm install && npm run demo:seed
```

- **Startup.** The `app` container waits for a healthy `db`, runs
  `prisma migrate deploy`, and serves on port 3000 as the non-root `node`
  user.
- **Environment.** Compose passes every variable in `.env` to the container,
  then overrides `DATABASE_URL` (pointing at the `db` service) and `PORT`.
  `NODE_ENV` from `.env` (`development` in the template) overrides the
  image's `production` default, which gives pretty logs instead of JSON.
- **Database.** Postgres is published on `localhost:5432`, so the host-side
  seed writes to the database the container reads.
- **Seed snapshots.** `docker compose exec app npm run db:seed` loads any
  snapshot placed in `seed/` from inside the container, with no Node needed
  on the host. With `seed/` empty it has nothing to load.

## Live sync

Live sync needs `GITHUB_TOKEN`. A fine-grained token with read-only access to
public repositories and no other permissions is enough. The default demo
repository is `anomalyco/opencode`. Its volume, about 6,500 PRs and 6,600
issues in eight weeks, is an estimate from the design phase, not a
measurement.

**Verification status.** The GitHub integration is verified against a
recorded fake: fixture pages covering paging, review overflow, bots,
self-reviews, rate-limit sleep and retries. It has not yet been run against
api.github.com from this checkout, so the commands below are the documented
path, not a recorded run.

```bash
# Start a sync of the default window (last 8 complete ISO weeks).
# The body is optional: {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}, at most 26 weeks.
curl -si -X POST http://localhost:3000/api/v1/repos/anomalyco/opencode/sync
# HTTP/1.1 202 Accepted
# Location: /api/v1/sync-jobs/<id>

# Poll until status is "succeeded" (or "failed", with an error kind)
curl -s http://localhost:3000/api/v1/sync-jobs/<id>

# Then query the default window
curl -s http://localhost:3000/api/v1/repos/anomalyco/opencode/insights
curl -s http://localhost:3000/api/v1/repos/anomalyco/opencode/narrative
```

- **Duration.** A first opencode sync is expected to take minutes. It pages
  through GitHub GraphQL with nested reviews and commits each page in its own
  transaction. The job's `counts` and `rateLimitRemaining` show progress, and
  the demo page polls them.
- **Rate limit.** Before each query, when fewer than 100 points remain, the
  client sleeps until the window's `resetAt`. A rate-limited response
  with no points left (GraphQL `RATE_LIMITED` with `remaining` 0 or absent,
  or HTTP 403/429 with `x-ratelimit-remaining: 0`) sleeps until the known
  reset plus 1 s, capped at an hour, unless `retry-after` says otherwise. A
  secondary limit with points left, and other transient failures, back off
  exponentially with jitter.
  At most 5 attempts are made per query.
- **Repeat requests.** A second POST while a job is queued or running returns
  that job with 200, whatever window it asks for.
- **Later syncs.** A later sync inside the covered range is incremental: it
  fetches only items updated since the last successful job. A sync whose
  `from` is earlier than the covered range runs a backfill. A backfill
  extends coverage to the old coverage end, so when its window ends before
  the old coverage starts, it also fetches commits across the gap.
- **Coverage.** Insights and narrative never trigger a sync. When the
  requested window extends past what was synced, they answer with
  `coverage.partial: true`, and each bucket outside the synced range has
  `covered: false` and null metrics: no data, not zero activity.

## Architecture

```
   api.github.com (GraphQL v4)                       api.anthropic.com (Messages API)
             ^                                                       ^
             | sync jobs only                                        | cache misses only
+------------|--------------- NestJS app (/api/v1) ------------------|------------+
|  ingestion                   signals                   synthesis                |
|  POST sync -> 202 +          15 SQL metrics per        bounded tool loop:       |
|  Location, in-process        bucket, leaderboards,     Opus 5.5, 4 read-only    |
|  runner, one job per         4 detectors        -----> tools, max 6 iterations; |
|  repo, rate-limit aware                    insights,   grounding, calibration   |
|                                          tool queries                           |
|      |                           ^                         |        ^           |
+------|---------------------------|-------------------------|--------|-----------+
       | writes                    | reads                   | writes | reads
       v                           |                         v        |  (narratives)
+---------------------------------------------------------------------------------+
| Postgres 16: repositories, sync_jobs, actors, pull_requests, reviews, issues,   |
|              commits, narratives (cache)                                        |
+---------------------------------------------------------------------------------+
           static demo page (public/) and Swagger UI (/docs) on the same app
```

- **Ingestion** (`src/ingestion`, `src/github`) is the only code that calls
  GitHub. Every other endpoint reads only Postgres.
- **Signals** (`src/signals`) runs hand-written, parameterised SQL and then
  pure-function detectors.
- **Synthesis** (`src/synthesis`) is the only code that calls Anthropic, and
  only on a narrative cache miss.

Request flow for `GET /narrative`:

1. **Insights.** The same code path as `GET /insights` computes the buckets,
   leaderboards, signals and coverage.
2. **409.** If the window has no activity, the request returns
   `no-signal-data` without calling the model.
3. **Cache.** The cache key is a sha256 of the repo, the resolved window, the
   bucket, `includeBots`, the signals fingerprint, a digest of the user
   message (every number the model is shown), `coverage.lastSyncedAt`, the
   prompt version, the model and the effort. A hit returns the stored
   response. Identical
   concurrent misses share one generation.
4. **Ledger.** A `FactLedger` is seeded with every number the user message
   shows: cells of synced buckets, the top 10 rows of each leaderboard,
   signal observed and baseline values, and example items.
5. **Tool loop.** The SDK's beta tool runner calls `claude-opus-5-5` with:
   - effort `medium`, streaming, and prompt caching on the system prompt;
   - server-side fallback;
   - at most 6 iterations;
   - the output schema in `output_config.format`.

   The four tools (`get_metric_series`, `get_bucket_examples`,
   `get_contributor_activity`, `compare_windows`) read Postgres and record
   every number they return in the ledger. The final JSON is re-validated
   with Zod. A refusal, truncation, iteration cap or unparseable output
   returns a 502.
6. **Grounding.** Each evidence item must name a known signal (if any) and a
   ledger key, and its value must match within tolerance. Items that fail are
   removed. Hypotheses with no surviving evidence are dropped. Numerals in the
   prose are flagged, not rejected.
7. **Calibration.** Rule-based caps are applied to the model's confidence.
8. **Store.** The response is upserted into `narratives` and returned. One
   metadata-only log line is written: tokens, cost, tool calls, latency and
   grounding status.

## API

Base path `/api/v1`. Responses are JSON.

**Errors.** Errors are RFC 9457 `application/problem+json`, with
`type: https://repo-pulse.local/problems/<type>`, `title`, `status`, `detail`,
`instance` and `requestId`. The `requestId` is taken from a valid
`x-request-id` header, or generated, and echoed back in the same header and in
the logs.

**Path parameters.** `owner` and `repo` must match
`^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$`.

**Query parameters** for insights and narrative:

| Parameter | Values | Default |
|---|---|---|
| `from` | ISO date, inclusive | 8 weeks before `to` |
| `to` | ISO date, exclusive | Monday 00:00 UTC of the current week |
| `bucket` | `week` or `day` | `week` |
| `includeBots` | `true` or `false` | `false` |
| `refresh` (narrative only) | `true` or `false` | `false` |

| Method and path | Purpose | Status codes |
|---|---|---|
| `POST /repos/{owner}/{repo}/sync` | Start a background sync. The body is optional: `{from?, to?}`. | **202** new job, with `Location: /api/v1/sync-jobs/{id}`<br>**200** a queued or running job already exists for the repo<br>**400** `validation-error`<br>**404** `github-repo-not-found`<br>**503** `github-token-missing` or `github-unavailable` |
| `GET /sync-jobs/{id}` | Job status (`queued`, `running`, `succeeded`, `failed`), mode (`initial`, `incremental`, `backfill`), counts per entity, `rateLimitRemaining`, error kind | **200**<br>**400** id is not a UUID<br>**404** `not-found` |
| `GET /repos/{owner}/{repo}/insights` | Per-bucket metrics, leaderboards (top 20), signals with up to 5 examples, detector `parameters`, coverage and availability | **200**<br>**400** `validation-error` (bad window, more than 26 weeks, `to` in the future, bad bucket)<br>**404** `repo-not-synced` |
| `GET /repos/{owner}/{repo}/narrative` | Headline, narrative, grounded and calibrated hypotheses, caveats, grounding report, `meta` | **200** with `cached`<br>**400**<br>**404** `repo-not-synced`<br>**409** `no-signal-data`<br>**429** `rate-limited`, with `Retry-After: 60`<br>**502** `synthesis-failed`, with `reason`: `refusal`, `max_tokens`, `max_iterations`, `unparseable`, or `upstream_<status>` for any other provider error (such as an unknown `ANTHROPIC_MODEL`)<br>**503** `llm-not-configured`, or `llm-unavailable` with `Retry-After: 30` |
| `GET /health` | Liveness and database reachability | **200** `{"status":"ok","db":"up"}`<br>**503** with `"db":"down"` |

Outside `/api/v1`:

- `GET /` serves the demo page.
- `GET /docs` serves the Swagger UI.
- `GET /docs-json` serves the OpenAPI document.

Unhandled errors return 500 `internal`, with no internal detail. Framework
HTTP errors map 400 and 422 to `validation-error`, 404 to `not-found`, 409 to
`conflict` and 429 to `rate-limited`; any other status (405, 413, ...) keeps
its real status with type `internal`.

### Example: insights (trimmed, from `evalco/service-1`)

```json
{
  "repository": { "owner": "evalco", "name": "service-1", "defaultBranch": "main", "url": "https://github.com/evalco/service-1" },
  "window": { "from": "2026-08-31T00:00:00.000Z", "to": "2026-10-26T00:00:00.000Z" },
  "bucket": "week",
  "includeBots": false,
  "coverage": { "from": "2026-08-31T00:00:00.000Z", "to": "2026-10-26T00:00:00.000Z", "partial": false, "lastSyncedAt": "2026-10-26T00:00:00.000Z" },
  "availability": { "pullRequests": "available", "issues": "available", "commits": "available" },
  "buckets": [
    {
      "key": "2026-10-05", "start": "2026-10-05T00:00:00.000Z", "end": "2026-10-12T00:00:00.000Z", "partial": false, "covered": true,
      "metrics": {
        "prs_opened": 25, "prs_merged": 17, "prs_closed_unmerged": 1,
        "time_to_first_review_p50_h": 21.53333333333333, "time_to_merge_p50_h": 41.38333333333333,
        "reviews_submitted": 31, "approvals": 21,
        "review_concentration_top1": 0.3870967741935484, "review_concentration_hhi": 0.3506763787721124,
        "issues_opened": 5, "issues_closed": 4, "issue_time_to_close_p50_h": 115.94999999999999,
        "commits": 20, "active_authors": 4, "bus_factor_50": 2
      }
    }
  ],
  "leaderboards": {
    "contributors": [{ "login": "dave", "mergedPrs": 50, "commits": 53, "linesChanged": 12394 }],
    "reviewers": [{ "login": "alice", "reviews": 108, "approvals": 77 }],
    "mergers": [{ "login": "alice", "prsMerged": 63 }]
  },
  "signals": [
    {
      "id": "bc261ce93654",
      "detector": "robust_outlier",
      "metric": "time_to_first_review_p50_h",
      "bucket": "2026-10-05",
      "observed": 21.53333333333333,
      "baseline": { "median": 6.291666666666667, "scale": 1, "n": 7, "scaleSource": "floor" },
      "score": 15.241666666666664,
      "direction": "up",
      "severity": "high",
      "description": "time_to_first_review_p50_h was 21.53 in 2026-10-05, versus a typical 6.29 (robust z 15.24)",
      "entity": null,
      "examples": [
        { "kind": "pull_request", "ref": "#161", "title": "Change 161", "author": "dave", "value": 84.18333333333334, "unit": "hours", "url": "https://github.com/evalco/service-1/pull/161" }
      ]
    }
  ],
  "parameters": {
    "outlierZ": 3, "highSeverityZ": 5, "minBaseline": 4, "levelShiftRecentBuckets": { "week": 2, "day": 7 },
    "concentrationTop1Share": 0.5, "concentrationMinReviews": 10, "concentrationHighShare": 0.75,
    "divergenceScaleUnits": 1, "divergenceHighScaleUnits": 2
  }
}
```

### Example: narrative (trimmed)

This is the response for the same repository and window, from run 2 of the
`latency_spike` case in the committed eval baseline
(`eval/reports/2026-10-29T05-17-04.490Z/`). It shows one of two hypotheses and
three of five evidence items. `generatedAt` is elided.

```json
{
  "repository": { "owner": "evalco", "name": "service-1", "defaultBranch": "main", "url": "https://github.com/evalco/service-1" },
  "window": { "from": "2026-08-31T00:00:00.000Z", "to": "2026-10-26T00:00:00.000Z" },
  "bucket": "week",
  "cached": false,
  "generatedAt": "...",
  "headline": "Review and merge speed dipped for one week starting 2026-10-05, probably because bob had less time to review, and was back to normal the next week",
  "narrative": "In the week of 2026-10-05, PRs waited a median of 21.53 hours for their first review, against a typical 6.29. ...",
  "hypotheses": [
    {
      "statement": "Review capacity dropped for a while in the week of 2026-10-05, mostly because bob was less available ...",
      "confidence": 0.55,
      "model_confidence": 0.55,
      "adjustments": [],
      "evidence": [
        { "signal_id": "bc261ce93654", "metric": "time_to_first_review_p50_h", "bucket": "2026-10-05", "entity": null, "value": 21.53333333333333, "note": "First-review latency spike" },
        { "signal_id": "bc261ce93654", "metric": "time_to_first_review_p50_h.baseline_median", "bucket": "2026-10-05", "entity": null, "value": 6.291666666666667, "note": "Typical first-review latency" },
        { "signal_id": null, "metric": "reviews_given", "bucket": "2026-10-05", "entity": "bob", "value": 7, "note": "bob's reviews about halved that week" }
      ],
      "alternative_explanations": [
        "The PRs that week were larger or harder to review, which slowed reviewers down",
        "A holiday or offsite cut everyone's time, not just bob's (commits also dipped to 20)"
      ],
      "suggested_check": "Ask whether bob, or the team, was away or tied up with other work in the week of 2026-10-05, and look at who finally gave the first review on #161 and #170."
    }
  ],
  "data_caveats": ["Each latency metric is a weekly median over about 20 PRs, so one week's spike can come from a few slow PRs."],
  "grounding": { "status": "ok", "rejected": [], "unverifiedNumbers": [10, 15], "droppedHypotheses": 0 },
  "meta": {
    "model": "claude-opus-5-5",
    "promptVersion": "v1",
    "usage": { "inputTokens": 8, "outputTokens": 2075, "cacheReadTokens": 26408, "cacheWriteTokens": 2889, "costUsd": 0.061259 },
    "toolCalls": 5,
    "turns": 3,
    "latencyMs": 22178
  }
}
```

**The planted cause is not bob.** It is a uniform 5x latency increase, so
this hypothesis is wrong even though every evidence item is correct and
grounded. NOTES.md ("Eval results") explains why that happens and what the
eval does and does not measure.

A grounding rejection looks like this:

```json
{ "hypothesisIndex": 0, "evidence": { ... }, "reason": "value_mismatch", "expected": 21.53 }
```

The other reasons are `unknown_fact` and `unknown_signal`.

## Configuration

All configuration comes from environment variables, parsed with Zod in
`src/config/env.ts`. Validation errors name the field, never the value. An
empty value (for example `GITHUB_TOKEN=`) counts as unset.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | (required) | Postgres connection string |
| `GITHUB_TOKEN` | unset | GitHub token for sync. Unset means `POST /sync` returns 503 `github-token-missing`. |
| `ANTHROPIC_API_KEY` | unset | Anthropic key. Unset means a narrative cache miss returns 503 `llm-not-configured`. |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model id. Part of the narrative cache key. |
| `ANTHROPIC_EFFORT` | `medium` | `low`, `medium` or `high`, sent as `output_config.effort`. Part of the cache key. |
| `PORT` | `3000` | HTTP port |
| `SYNC_MAX_WEEKS` | `26` | Maximum window length for sync, insights and narrative |
| `NARRATIVE_RATE_LIMIT_PER_MIN` | `10` | Narrative requests per client IP per 60 seconds |
| `CORS_ORIGIN` | unset | Comma-separated allowed origins. Unset means CORS is off (same origin only). |
| `LOG_LEVEL` | `info` | pino level |
| `NODE_ENV` | `development` | `development` (pretty logs), `test` or `production` (JSON logs) |
| `DATABASE_URL_TEST` | (in `.env.test`) | Database for e2e tests and the eval suite, which truncate it. Never point it at real data. |

## Testing

```bash
npm test                 # unit tests: detectors, grounding, calibration, cache key, prompt, runner; no DB (177 tests)
npm run test:e2e         # API and SQL against repo_pulse_test, with fake GitHub and fake model clients (117 tests)
npm run eval:detectors   # the deterministic detector suite only (35 tests)
npm run eval -- --dry    # builds the six fixtures and runs the detectors; no model calls
npm run eval             # 6 planted-cause cases x 3 runs against the real API
```

- **Database.** The e2e and eval suites use `repo_pulse_test`, which compose
  creates on first start. Both truncate it, so run them one at a time.
- **Eval cost.** `npm run eval` costs real money, about $0.75 per full run
  with Opus 5.5. It writes `eval/reports/<timestamp>/report.{json,md}`.
- **Eval options.** `--runs N` and `--case <name>` narrow a run.
- **Exit code.** The eval exits 1 in either of two cases:
  - schema-and-grounding passes in fewer than 90% of runs;
  - `latency_spike` or `concentration` never names the planted metric.
- **Baseline.** The committed baseline is
  `eval/reports/2026-10-29T05-17-04.490Z/report.md`.
- **CI** runs lint, typecheck, unit, e2e, build, `npm audit --audit-level=high`
  and a Docker build. The eval is a manual workflow (`eval.yml`) because it
  spends API credit.

## Security

- **Secrets.** Secrets come only from the environment. `.env` is gitignored,
  and `.env.example` holds names and empty placeholders. No secret appears in
  logs:
  - pino redacts `authorization`, `x-api-key` and `cookie` headers;
  - GitHub errors are logged by kind and status only, and the token is
    scrubbed from any GraphQL error text;
  - narrative log lines carry metadata only, never prompt or model text;
  - SDK stream errors that could quote model text are replaced before they
    reach the error filter.
- **Read-only token.** The GitHub token only needs read access to public
  repositories. The service never writes to GitHub, and the model's four
  tools are read-only.
- **No SSRF.**
  - Outbound HTTP goes only to `https://api.github.com/graphql`, a constant,
    and to the Anthropic SDK's default base URL. No user-supplied URL is ever
    fetched.
  - `owner` and `repo` are regex-validated and passed as GraphQL variables,
    never interpolated.
  - All SQL is parameterised `Prisma.sql`.
- **Untrusted text.** PR and issue titles and logins are third-party text.
  - The system prompt tells the model to treat them as data and never follow
    instructions inside them.
  - The output is schema-constrained and grounding-validated, so injected
    text cannot add an unverified number to the evidence.
  - The demo page writes every API string with `textContent` only.
- **Browser hardening.** helmet sets a strict CSP (`default-src 'self'`,
  `script-src 'self'`, `style-src 'self'`). `/docs` alone allows inline
  styles, because Swagger UI needs them. CORS is off unless `CORS_ORIGIN` is
  set.
- **Spend protection.** The narrative route is rate-limited per client IP (10
  per minute by default). Cached narratives never call the model.
- **Input validation.** All input is validated with Zod: strict enums, ISO
  dates and a 26-week maximum window. Invalid input returns 400 before any
  upstream call.

## Further reading

- [docs/metrics.md](docs/metrics.md): every metric, detector formula,
  grounding rule, calibration rule and the cache key, as implemented.
- [NOTES.md](NOTES.md): architecture decisions, trade-offs, known
  limitations, eval findings and how AI was used to build this.
- `docs/superpowers/`: the design spec and the implementation plan this was
  built from.
