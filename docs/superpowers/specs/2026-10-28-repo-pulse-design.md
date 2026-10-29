# Repo Pulse: collaboration signal detection and LLM insight synthesis over GitHub

Date: 2026-10-28
Status: reviewed; builder-check questions resolved in section 18
Context: Tempo "Loop" home assignment for a Senior AI/ML Engineer role

## 1. Intent

Build a small, production-grade service that ingests collaboration data from a
public GitHub repository, detects statistically unusual patterns in how the team
works (review latency, throughput, review-load concentration, issue flow), and
has Claude synthesize a short, grounded narrative over those signals: what is
unusual, a root-cause hypothesis, a calibrated confidence score, and an
evidence chain that points back to exact numbers the service computed.

### Why this shape

The assignment asks for one insight endpoint and one LLM narrative endpoint.
The role it is for builds exactly this at Tempo: signal and anomaly detection
over portfolio data, then an LLM "insight synthesis engine" that produces root
causes, confidence scores and evidence chains, backed by evaluation pipelines
and confidence calibration. So the design treats the LLM endpoint as the main
event and the metrics endpoint as the signal layer that feeds it. The thing the
reviewers should come away believing: this person gets AI features right, and
builds them as production systems rather than demos.

The candidate will defend every decision in a live code tour, so everything
must be explainable in one or two sentences. Clever that cannot be explained is
a failure.

## 2. Goals, non-goals, anti-goals

### Goals

1. Correct, checkable numbers. Every metric has a one-line definition in the
   README and can be verified against GitHub by hand.
2. Detectors that separate noise from a real change, with their baselines and
   thresholds visible in the response.
3. An LLM synthesis that is grounded: every evidence item in the output is
   validated against the numbers the service actually produced. Hallucinated
   evidence is caught, not shipped.
4. A confidence score that means something: model self-report adjusted by a
   deterministic, documented calibration rule.
5. A small eval suite that runs the synthesis over fixtures and asserts
   structure, grounding and confidence behaviour, so prompt changes are
   regression-tested.
6. Sensible HTTP semantics, validated input, no secrets in repo or logs,
   no SSRF or injection paths.
7. Reasonable upstream usage: GraphQL, incremental sync, persisted data, cached
   narratives. Insight endpoints never call GitHub or the LLM on the hot path
   unless the result is not already stored.
8. Two-command local setup and a README a reviewer can follow in 60 seconds.

### Non-goals

- Multi-tenancy, authentication on our own API, or user accounts.
- Supporting providers other than GitHub (the code should make it obvious where
  a second provider would plug in, nothing more).
- Real-time or webhook-driven ingestion.
- A rich frontend. One static page is enough to demo.
- Bedrock. The Anthropic API is used directly; the notes will say how the
  client swaps for Bedrock (one client class change).

### Anti-goals (would make the submission worse even if they work)

- Framework ceremony for its own sake: CQRS buses, event sourcing, microservices.
- An agent that is hard to explain: multi-agent orchestration, planner/executor
  hierarchies, dynamic tool discovery. The agent is a bounded tool-use loop with
  a handful of tools and a fixed output schema.
- A frontend with its own build pipeline that steals time from the core.
- Dead code, speculative abstractions, or "TODO" scaffolding.
- Any number in the narrative that cannot be traced to a stored row.

## 3. Constraints

- Language and stack: TypeScript, NestJS, Prisma, Postgres (via docker compose).
  Chosen because the candidate is most at home defending them.
- LLM: Anthropic API with the key already present in `.env` as
  `ANTHROPIC_API_KEY`. Model: `claude-opus-5-5` by default, configurable via
  env. Thinking is adaptive (omit the `thinking` parameter); effort is set
  explicitly (default `medium`) via `output_config.effort`. Forced
  `tool_choice` is not supported on this model, so output is obtained through
  structured outputs (`output_config.format`) or `tool_choice: auto` plus
  instruction. Server-side refusal fallbacks are enabled (`fallbacks:
  "default"` with the `server-side-fallback-2026-07-01` beta).
- GitHub: a read-only personal access token in `GITHUB_TOKEN` is required,
  because GraphQL needs authentication. Public repos only.
- Default demo repo: `anomalyco/opencode`. Very high volume (about 6,500 PRs
  and 6,600 issues in eight weeks), which is why ingestion is GraphQL,
  background and incremental. Secondary example for docs and lighter demos:
  `dataelement/dsh-desktop`. `deepseek-ai/deepseek-harness` has PRs and issues
  disabled and is the graceful-degradation example (commit-only signals).
- Time: one week. Submission is a git repo plus NOTES.md.
- Reviewers will read the code like a teammate's PR before the interview.

## 4. System overview

Three layers behind one NestJS app, plus a Postgres database.

```
GitHub GraphQL ──► Ingestion (background sync jobs) ──► Postgres
                                                          │
                     Signals (SQL aggregates + detectors) ◄┘
                                │
                     Synthesis (Claude agent, tools over signals, grounding check)
                                │
                     HTTP API + static demo page
```

Insight and narrative endpoints read only from Postgres (and the narrative
cache). Sync is triggered explicitly and runs in the background with a status
endpoint. This keeps request latency predictable and makes "where does this
number come from" answerable from the database alone.

## 5. Ingestion layer

### Scope of data per repository and window

- Pull requests: number, title, author, created, merged, closed, additions,
  deletions, changed files, base branch, state, `isDraft`.
- Reviews on those PRs: author, state (APPROVED, CHANGES_REQUESTED, COMMENTED,
  DISMISSED), submitted at, comment count.
- Issues: number, title, author, created, closed, state, labels (names only).
- Commits on the default branch: sha, author login (or author name/email when
  no GitHub account), committed date, additions, deletions.
- Repository metadata: default branch, `hasIssuesEnabled`, whether PRs exist,
  ingestion coverage window.

Review comments bodies and PR bodies are not stored. Titles are stored because
they help the model and the UI name what a spike was about. Titles are treated
as untrusted data everywhere they appear.

### Mechanism

- GitHub GraphQL v4, one query per entity type, 50 to 100 items per page with
  nested reviews (up to a capped number per PR, with a follow-up fetch only for
  PRs exceeding the cap). Ordered by `UPDATED_AT` descending with a stop
  condition on the window start so a window sync is bounded.
- Incremental: each repo stores one `lastSyncedAt` high-water mark, set to
  the start time of the last successful job. A re-sync fetches only items
  updated since the mark and upserts them. A failed job does not advance it.
- Rate-limit aware: every query requests `rateLimit { remaining resetAt cost }`
  and the client pauses until `resetAt` when remaining drops below a reserve.
  Transient errors (5xx, 502 from GraphQL, network) retry with jittered
  exponential backoff; 401/403/404 fail the job with a clear reason.
- Sync jobs are rows in Postgres (`SyncJob`: repo, requested window, status
  queued/running/succeeded/failed, counters per entity, error message, started
  and finished times). Execution runs in-process with a simple queue that
  allows one running job per repo; a second request while one runs returns the
  existing job. This is deliberately not BullMQ or a worker process; the notes
  explain that the job table is the seam where a real queue would go.
- Window: a request may ask for up to 26 weeks of history; default 8 weeks.
  Each repo records one contiguous coverage range (`coveredFrom`,
  `coveredTo`). A sync request whose `from` is earlier than `coveredFrom`
  runs a backfill: it pages older items down to the new start and then
  extends the range. A request inside the covered range runs the incremental
  path from the high-water mark. POST sync returns the running job if one
  exists for the repo, whatever its window; otherwise it starts a new one.
  The insights and narrative endpoints never trigger a sync. When a requested
  window extends beyond coverage they still answer, with `coverage.partial =
  true`, the covered range, and a hint to run a wider sync; the calibration
  rule caps confidence in that case.

### Edge cases to handle explicitly

- Repo with issues disabled: issue entity marked unavailable, not failed.
- Repo with PRs disabled or none in window: PR and review signals unavailable.
- Commits without a GitHub user (author login null): attributed to the
  commit author name/email hash, flagged as unlinked.
- Bot accounts (login ends with `[bot]` or GraphQL `__typename == Bot`): stored
  with an `isBot` flag; leaderboards and concentration metrics exclude bots by
  default with a query parameter to include them.
- Self-reviews (review author equals PR author) are excluded from review
  latency and review-load metrics.
- Force-pushed or rewritten history: commits are upserted by sha; deleted shas
  are not pruned (documented limitation).

## 6. Signals layer

### Time buckets

Windows are bucketed by ISO week by default; `bucket=day` is allowed for short
windows. A bucket is keyed by its start date in UTC. Metrics are computed in
SQL with `date_trunc`, grouped per bucket, never by iterating rows in
JavaScript.

The default window snaps to complete buckets: "last 8 weeks" means the last 8
full ISO weeks ending on the most recent Sunday (UTC). When a caller supplies
explicit dates that cut a bucket, the edge buckets are still returned, each
with `partial: true` and its covered day count, but detectors exclude partial
buckets from both baseline and flagging. This prevents the trailing half-week
from reading as a collapse in throughput on every run.

### Metrics (each has a one-line definition in the README)

Per bucket:

| Metric | Definition |
|---|---|
| `prs_opened` | PRs created in bucket |
| `prs_merged` | PRs merged in bucket |
| `prs_closed_unmerged` | PRs closed without merge in bucket |
| `time_to_first_review_p50_h` | Median hours from PR creation to first non-author review, for PRs whose first review landed in bucket |
| `time_to_merge_p50_h` | Median hours from PR creation to merge, for PRs merged in bucket |
| `reviews_submitted` | Non-author reviews submitted in bucket |
| `approvals` | Reviews with state APPROVED in bucket |
| `review_concentration_top1` | Share of non-author reviews in bucket by the single busiest reviewer |
| `review_concentration_hhi` | Herfindahl index of review share across reviewers (0 to 1) |
| `issues_opened` / `issues_closed` | Issues created / closed in bucket |
| `issue_time_to_close_p50_h` | Median hours open for issues closed in bucket |
| `commits` | Commits on default branch in bucket |
| `active_authors` | Distinct commit authors in bucket |
| `bus_factor_50` | Smallest number of authors whose commits cover at least 50% of the bucket's commits |

Leaderboards over the whole window: top contributors (merged PRs authored,
commits, lines changed), top reviewers (reviews, approvals), top mergers (PRs
merged by, from the PR's `mergedBy` field). "Top closers" of issues was
dropped: GitHub GraphQL exposes who closed an issue only through timeline
events, which would cost one extra nested connection per issue for a
leaderboard that merge-by already covers. Each row has the exact count and
the identifier used, so it can be spot-checked on GitHub.

### Detectors

Detectors are pure functions over a metric series. Each returns a list of
`Signal` objects or a status of `insufficient_data` / `unavailable`.

1. **Robust outlier** (per metric, per bucket). Baseline is all other buckets
   in the window (minimum 4). Score is a robust z-score:
   `(x - median) / (1.4826 * MAD)`. If MAD is 0, fall back to IQR / 1.349;
   if still 0 the baseline is perfectly flat, and the scale becomes a floor of
   `max(1, 0.1 * |median|)` so a large departure from a flat baseline is still
   flagged while trivial wobble is not. The response says which scale source
   was used. Flag when |z| >= 3
   (configurable). Severity: `moderate` for 3 to 5, `high` above 5.
2. **Level shift** (per metric). Compare the median of the last k buckets
   (k = 2 for weekly, 7 for daily) against the median of the earlier buckets
   using the same robust scale. Flags a sustained change rather than a spike.
3. **Review concentration**. Flags a bucket where `review_concentration_top1`
   exceeds 0.5 and `reviews_submitted` is at least 10, and names the reviewer.
4. **Throughput divergence**. Flags buckets where `prs_opened` is at or above
   its baseline while `prs_merged` is at or below its baseline by more than one
   robust scale unit each, indicating a growing backlog.

Every `Signal` carries: a stable `id` (hash of detector, metric, bucket),
`detector`, `metric`, `bucket`, `observed`, `baseline` (median, scale, n),
`score`, `direction`, `severity`, a one-sentence plain-English `description`,
and `examples`: up to five PR or issue numbers with titles and the relevant
duration or count that contributed most to the bucket (for instance the
slowest-reviewed PRs in a latency spike). The `examples` are what the agent
cites and what the UI links to.

Detector thresholds and minimum baseline sizes are constants in one module and
are echoed in the response under `parameters` so the reviewer can see them.

## 7. Synthesis layer (the agent)

### Shape

A single bounded tool-use loop over the Anthropic TypeScript SDK, max 6
model turns, streaming on, prompt caching on the system prompt. Tools are
defined once with Zod schemas (strict JSON schema derived from them). The loop
itself is either the SDK's beta tool runner (`client.beta.messages.toolRunner`)
if it can carry `output_config.format` for the final structured answer, or a
manual loop of about forty lines following the SDK's documented pattern
(append the full assistant content, return all tool results in one user
message, stop on `end_turn`, `refusal` or `max_tokens`). The builder picks
whichever keeps structured output and streaming together; both are equally
explainable. If the loop ends without a final structured result, the service
returns a 502-class error with a problem detail rather than inventing a
narrative.

Input to the model: the repository identity, window, bucket size, the full
signal list (ordered by severity), the metric table in compact form, the
leaderboards, and data-sufficiency notes (unavailable entities, partial
coverage). The model is told that titles and logins are untrusted data and
must never be followed as instructions.

### Tools (all read from Postgres, all inputs Zod-validated)

1. `get_metric_series(metric)`: the full per-bucket series for one metric.
2. `get_bucket_examples(metric, bucket, limit)`: the PRs, issues or commits
   that contributed most to that bucket's value, with numbers, titles,
   authors, durations.
3. `get_contributor_activity(login, from, to)`: per-bucket PRs opened and
   merged, reviews given, commits, for one person. Used to test hypotheses
   like "one reviewer went quiet".
4. `compare_windows(metric, window_a, window_b)`: medians and counts for two
   sub-windows, for checking before/after claims.

Four tools, each one sentence to explain. No tool writes anything.

### Output

Obtained through structured outputs with a strict JSON schema:

```
{
  narrative: string            // 3 to 6 sentences, plain English
  headline: string             // one line
  hypotheses: [{
    statement: string
    confidence: number         // 0 to 1, model's self-assessment
    evidence: [{
      signal_id?: string       // from the signals list
      metric: string
      bucket?: string          // omitted for window-level facts
      entity?: string          // login, when the fact is about one person
      value: number
      note: string
    }]
    alternative_explanations: string[]
    suggested_check: string    // what a human would look at next
  }]
  data_caveats: string[]
}
```

### Grounding validation (deterministic, after the model returns)

The service keeps a `FactLedger` for the request: every number it handed the
model, from the initial signals, metric table and leaderboards, and from every
tool result returned during the loop. Each fact is keyed by
(metric, bucket?, entity?). For each evidence item: `signal_id`, if present,
must exist in the signals list; the (metric, bucket, entity) key must exist in
the ledger; `value` must match the ledger value within a per-unit tolerance
(0.5 absolute for counts and hours, 0.01 absolute for ratios in 0 to 1). Items
that fail are removed and recorded under `grounding.rejected` with the reason.
Per-person facts are therefore first-class evidence, not prose; the ledger is
also what makes "one reviewer went quiet" checkable. A hypothesis
with no surviving evidence is dropped. If every hypothesis is dropped, the
response still returns, with an empty hypotheses list, the narrative, and
`grounding.status = "failed"`, and the request is logged as a grounding
failure for the eval dashboard.

Narrative prose is handled more lightly, by design: the prompt instructs the
model to use only numbers that appear in its evidence items. After the fact,
the service extracts numerals from the narrative and headline and lists any
that match no evidence value under `grounding.unverified_numbers`. This is a
flag, not a rejection; it shows up in the UI and the eval report. Rejecting or
rewriting prose would be heavier than the value it adds.

### Confidence calibration (deterministic, documented)

Final confidence per hypothesis = model confidence, then:

- capped at 0.4 if fewer than 2 surviving evidence items;
- capped at 0.6 if the strongest cited signal has severity `moderate`, and
  capped at 0.5 if no detector signal is cited at all;
- multiplied by 0.8 if any evidence item was rejected by grounding;
- capped at 0.5 if coverage of the requested window is partial or any
  required entity was unavailable;
- rounded to two decimals.

The response includes both `model_confidence` and `confidence` with the list of
adjustments applied, so the behaviour is inspectable. The notes explain that
this is a rule-based proxy for calibration and what a real calibration loop
(scoring hypotheses against later outcomes) would replace it with.

### Caching and cost control

Narratives are stored in Postgres keyed by a hash of (repo, window, bucket
size, signals fingerprint, prompt version, model, effort). A repeat request
returns the stored narrative with `cached: true` and its age. Token usage,
latency, tool-call count and the cache hit flag are logged per request and
returned in a `meta` block. The narrative endpoint is rate-limited per client
IP (NestJS throttler) to protect spend.

### Prompt management

The system prompt and output schema live in versioned files under
`src/synthesis/prompts/` with a `PROMPT_VERSION` constant that feeds the cache
key and the eval report, so a prompt change is visible as a version bump.

## 8. Evaluation suite

`npm run eval` runs two groups and writes a JSON and Markdown report to
`eval/reports/<timestamp>/`.

1. **Detector evals (deterministic, no LLM).** Synthetic series with injected
   anomalies: a single latency spike, a level shift, a concentration event, a
   flat series, a short series. Assert exactly which buckets are flagged and
   that flat or short series produce no false positives. These also run as
   normal unit tests.
2. **Synthesis evals (LLM, 5 to 8 cases).** Fixture databases built from
   synthetic data with a known planted cause (for example: one reviewer's
   reviews drop to zero in week 6 and latency doubles). For each case assert:
   output validates against the schema; grounding rejects nothing; the top
   hypothesis names the planted metric and bucket; confidence on a planted
   case is higher than on the "nothing unusual" control case; the control
   case's narrative does not claim an anomaly. Hypothesis-matching uses
   simple keyword and field checks, not an LLM judge, so the suite is cheap
   and deterministic to grade. Each case runs 3 times and the report shows
   pass rate per case, token cost and latency.

The eval suite is the artifact that shows "evaluation-driven development" and
lets the candidate say what happens when they change the prompt.

## 9. HTTP API

Base path `/api/v1`. JSON everywhere. Errors use RFC 9457 `application/problem+json`
with `type`, `title`, `status`, `detail`, and a `requestId`. OpenAPI served at
`/docs` via `@nestjs/swagger`.

| Method | Path | Purpose | Notable semantics |
|---|---|---|---|
| POST | `/repos/{owner}/{repo}/sync` | Start or reuse a sync for a window | 202 Accepted with `Location: /api/v1/sync-jobs/{id}`; 200 with the existing job if one is already running for that repo; 404 if GitHub says the repo does not exist; 400 on invalid params |
| GET | `/sync-jobs/{id}` | Job status and progress | 200; 404 unknown |
| GET | `/repos/{owner}/{repo}/insights` | Metrics per bucket, leaderboards, signals, parameters, coverage | 200; 404 if repo never synced (detail says how to sync); 400 invalid window or bucket |
| GET | `/repos/{owner}/{repo}/narrative` | LLM synthesis over the insights | 200 (with `cached`); 404 as above; 409 if there are no signals and no data to reason about; 429 when throttled; 502 when the model returned nothing usable; 503 with `Retry-After` when the provider is unavailable |
| GET | `/health` | Liveness and DB reachability | 200 / 503 |

Query parameters: `from` and `to` as ISO dates (defaults: last 8 weeks ending
today, UTC), `bucket` in `week` or `day` (default `week`), `includeBots`
boolean (default false), and on narrative `refresh=true` to bypass the cache.
`owner` and `repo` must match `^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$`, which
also prevents path manipulation of the upstream URL. Window length is capped
at 26 weeks and `from` must precede `to`.

Responses carry `requestId`; the same id appears in logs.

## 10. Storage

Postgres 16 via docker compose; Prisma schema with these models:
`Repository`, `SyncJob`, `PullRequest`, `Review`, `Issue`, `Commit`,
`Actor` (login, isBot, display name), `Narrative` (cache). Indexes on
`(repositoryId, createdAt)`, `(repositoryId, mergedAt)`,
`(repositoryId, closedAt)`, `(pullRequestId, submittedAt)`,
`(repositoryId, committedDate)`, and unique keys on GitHub ids. Metric
queries are hand-written SQL through Prisma's parameterized `$queryRaw`
(tagged template, never string concatenation), kept in one `metrics.sql.ts`
module with one function per metric family. Migrations are committed.

## 11. Security

- Secrets only via environment; `.env` is gitignored and `.env.example` lists
  names only. Logger has a redaction list for `authorization`, `x-api-key`,
  and anything matching token patterns.
- Outbound HTTP is limited to `https://api.github.com` and the Anthropic SDK's
  base URL; no user-supplied URL is ever fetched.
- Input validation with Zod (or class-validator) on all params; strict
  allowlists for enums; numeric limits.
- SQL is parameterized; GraphQL variables are passed as variables, not
  interpolated.
- Prompt-injection posture: titles and logins are data; the model's output is
  schema-constrained and grounding-validated; the model has read-only tools.
- `helmet`, restricted CORS (same origin by default, configurable), request
  body size limit, throttling on the narrative route.
- Dependencies pinned; `npm audit` in CI.

## 12. Performance

- GraphQL pages of 50 to 100 with nested connections; hundreds of requests for
  an eight-week opencode window, not tens of thousands.
- Aggregations in SQL with indexes; endpoints return in tens of milliseconds
  on a repo with tens of thousands of rows.
- Narrative cached; cache hit avoids the model entirely.
- Sync runs in the background; the HTTP response never waits on GitHub.
- No large payloads are built in memory on the request path; the insights
  response is bounded by buckets × metrics plus leaderboards capped at 20 rows
  and signal examples capped at 5.

## 13. Frontend

One static page served by NestJS from `public/`: vanilla HTML, CSS and
JavaScript, no build step. It has: a repo input with a sync button and
progress readout polling the job endpoint; a window and bucket picker; a
metrics table with small inline SVG sparklines; the signals list with
severity, baseline, observed and example links to GitHub; a "Generate
narrative" button that renders the headline, narrative, hypotheses with
confidence and the adjustments applied, evidence items linking to the metric
and bucket, grounding status, and the meta block (cached, tokens, latency).
Light and dark mode via `prefers-color-scheme`. It exists to demo the API,
not to be a product.

## 14. Operability

- `README.md`: 60-second quickstart (`cp .env.example .env`, add two tokens,
  `docker compose up -d db`, `npm install`, `npm run db:migrate`,
  `npm run db:seed`, `npm run start:dev`, then three curl commands against
  the seeded repo; a second section covers the live opencode sync), metric definitions, API
  table, architecture diagram, configuration reference.
- `npm run db:seed` loads a committed snapshot (`seed/dsh-desktop.json`, a
  fixed eight-week window of `dataelement/dsh-desktop`, a few megabytes)
  so insights and narrative work immediately after setup, with no GitHub
  token and no waiting. The same loader feeds the e2e tests and the eval
  fixtures. `anomalyco/opencode` is the live path: trigger a sync, watch the
  job progress on the page, then query it. That wait is part of the demo,
  not a problem to hide.
- `docker compose up` alone also runs the app container for a zero-Node demo.
- `NOTES.md`: how to run, architecture tour and decisions (1 to 2 paragraphs),
  trade-offs and what was deliberately not done, what the next day would add,
  how AI tools were used.
- Structured JSON logs (pino) with `requestId`, route, latency, and for
  synthesis: model, tokens in/out, cache hit, tool calls, grounding result.
- GitHub Actions: lint, typecheck, unit tests, e2e tests against a Postgres
  service container. Eval suite is a manual workflow because it costs money.
- Tests: unit tests for detectors, calibration and grounding (pure functions);
  integration tests for metric SQL against a seeded test database; e2e tests
  for the API with the GitHub client and Anthropic client replaced by
  fixture-backed fakes.

## 15. Decisions made during brainstorming, and why

| Decision | Alternatives considered | Why |
|---|---|---|
| GitHub as the integration | Jira (on-brand for Tempo) | Public Jira data with real collaboration is hard to get without an org; GitHub needs only a PAT and has rich public data |
| anomalyco/opencode as default demo | dsh-desktop, deepseek-harness | Highest-signal data and well known; its volume forces GraphQL and background sync, which are the right production choices anyway |
| GraphQL over REST | REST with per-PR review calls | Reviews nested in one page; two orders of magnitude fewer requests |
| Background sync job with status endpoint | Sync on first request | Keeps insight latency predictable and HTTP semantics honest (202 + Location) |
| In-process job runner with a job table | BullMQ / Redis worker | Smaller, explainable; the job table is the seam for a real queue |
| Postgres + Prisma | SQLite, in-memory | Real aggregates in SQL, shows caching and repeat-query thinking; candidate's stack |
| Robust z-score and level shift detectors | Prophet, STL, ML anomaly models | Explainable in one sentence, parameter-visible, no training data needed for 8 to 26 buckets |
| Bounded tool-use loop with 4 read-only tools | Single-shot prompt; multi-agent | Single-shot cannot drill into examples; multi-agent is hard to explain and slow |
| Structured outputs for the final answer | Free text with regex | Schema guaranteed; grounding check becomes trivial |
| Deterministic grounding and calibration post-processing | Trust the model | This is the "trustworthy versus impressive-but-fragile" line from the role |
| Deterministic eval grading | LLM judge | Cheap, repeatable, no judge drift; adequate for planted-cause fixtures |
| Static page, no framework | Vite + React | Candidate asked for a small frontend; nothing to build or explain |
| Opus 5.5 default | Sonnet 5.5 | Quality on reasoning over numbers; cost is controlled by caching, throttling and `medium` effort; model is an env var |

## 16. Left to the builder

- Exact Prisma schema fields and the GraphQL query documents.
- Exact SQL for each metric and the test fixtures that verify it.
- Wording of the system prompt and the few-shot or rubric content, subject to
  the eval suite passing.
- Page layout and styling details of the demo page.
- Default detector constants beyond those stated (3.0 z threshold, minimum 4
  baseline buckets, concentration 0.5 with at least 10 reviews).
- Choice between Zod and class-validator for HTTP validation (Zod is already
  used for tools; prefer one library).
- Logging library and exact log fields.

## 17. Next-day list (for NOTES.md)

- Replace the in-process runner with BullMQ and a separate worker.
- Scheduled incremental syncs and webhook ingestion.
- Calibration loop: store hypotheses, let a human mark them right or wrong,
  compute reliability diagrams per confidence band.
- Expose the four read-only tools as an MCP server so other agents can use
  them; the tool definitions are already provider-neutral.
- Swap the Anthropic client for the Bedrock Mantle client behind the same
  interface.
- Second provider (GitLab) behind the ingestion interface.

## 18. Builder-check resolutions

A reviewer read the document as a builder and asked six questions. All were
settled here without changing what the user asked for.

| Question | Resolution |
|---|---|
| Can evidence cite per-person numbers, and what validates them? | Yes. Evidence gained an optional `entity` field, and grounding validates against a per-request `FactLedger` of every number shown to the model, including tool results. Section 7. |
| Partial buckets at window edges? | Default window snaps to complete ISO weeks; explicit windows return edge buckets flagged `partial` and detectors ignore them. Section 6. |
| Is prose number-checked? | Soft check only: numerals in the narrative that match no evidence value are listed under `grounding.unverified_numbers`, never rejected. Section 7. |
| Seed snapshot or live sync for the demo? | Both. A committed dsh-desktop snapshot makes the quickstart instant and feeds tests and evals; opencode is the live demo path. Section 14. |
| Widening the window past what was synced? | One contiguous coverage range per repo; an earlier `from` triggers a backfill; read endpoints never sync and report partial coverage instead. Section 5. |
| Grounding tolerance on ratio metrics? | Per-unit tolerance: 0.5 for counts and hours, 0.01 for ratios. Section 7. |
