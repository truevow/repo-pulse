# NOTES

## How to run

The README has the exact steps. The short version, with no GitHub token
needed:

```bash
cp .env.example .env    # set ANTHROPIC_API_KEY for narratives
docker compose up -d db && npm install && npm run db:migrate
npm run demo:seed       # loads evalco/service-1, the latency_spike eval fixture
npm run start:dev       # then open http://localhost:3000/
```

| Path | Command |
|---|---|
| Live sync | Set `GITHUB_TOKEN`, then `POST /api/v1/repos/anomalyco/opencode/sync` |
| Zero-Node demo | `docker compose up --build` |
| Tests | `npm test`, `npm run test:e2e`, `npm run eval -- --dry` (free) or `npm run eval` (about $0.75) |

## Architecture tour and main decisions

One NestJS app has three modules over Postgres.

- **Ingestion** pages GitHub GraphQL in background jobs:
  - a `SyncJob` row per job;
  - an in-process queue that runs one chain per repository;
  - a client that respects the rate limit and retries with jitter.

  Each repository keeps a coverage range and a high-water mark, so re-syncs
  are incremental and an earlier `from` runs a backfill.
- **Signals** computes 15 metrics per ISO week (or day) in parameterised SQL.
  Four pure-function detectors then run over the series: robust outlier,
  level shift, review concentration and throughput divergence. Every
  threshold they use is echoed in the response.
- **Synthesis** runs a bounded Claude tool loop. Deterministic code then:
  - checks every evidence item against a ledger of the numbers the model was
    shown;
  - applies rule-based confidence caps;
  - caches the result.

Read endpoints never call GitHub, and the model runs only on a narrative
cache miss. The line I cared about most is "trustworthy versus impressive":
the model may reason and be wrong, but it may not cite a number the service
did not compute.

| Decision | Instead of | Why |
|---|---|---|
| GraphQL, background sync with 202 and `Location` | REST, sync on first request | Two orders of magnitude fewer requests at opencode's volume; predictable insight latency |
| In-process runner with a job table | BullMQ and Redis | Smaller; the table is the seam for a real queue |
| Robust z-score, level shift, rule detectors | Prophet, STL, ML models | One sentence each, visible parameters, no training data, works on 8 to 26 points |
| Bounded loop, 4 read-only tools | Single shot; multi-agent | Single shot cannot drill into examples; multi-agent is slow and hard to defend |
| Structured output, then deterministic grounding and calibration | Trusting the model | Hallucinated evidence is caught, not shipped |
| Deterministic eval grading | LLM judge | Cheap, repeatable, no judge drift |
| Opus 5.5 at effort `medium` | Sonnet | Better reasoning over numbers; caching, throttling and effort control cost; the model is an env var |

**Agent harness.** I used the SDK's beta `toolRunner` rather than a manual
loop.

- **One streaming loop.** The runner carries `output_config.format` alongside
  the tools; the live API accepts the combination.
- **The schema, without `parse`.** I pass the schema from
  `betaZodOutputFormat` but not the helper's `parse`. With `parse` attached,
  the SDK parses the final text whatever the stop reason. It then throws a
  generic error, quoting model text, on a refusal or a truncation.
- **Stop reason first.** Without `parse`, the runner maps the stop reason
  first and then parses the text. The service re-validates with Zod, so
  every failure becomes a 502 with a reason, and model text never reaches
  the logs.
- **Tool bounds.** Strict tool schemas cannot carry numeric
  `minimum`/`maximum`; the first live call found this. Bounds are therefore
  described in the schema and enforced inside the tool.

## What I would do next

1. **A cause-attribution check in the eval.** Today the eval grades whether
   the right signal is cited, not whether the causal story is right (see
   "Eval results").
2. **Prompt v2.** No numerals in the prose when there are no hypotheses,
   with a `PROMPT_VERSION` bump.
3. **A calibration loop.** Store hypotheses, let a human mark them right or
   wrong, and compute reliability per confidence band. Replace the hand-set
   caps with what that shows.
4. **A real job queue.** BullMQ and a separate worker in place of the
   in-process runner, plus a partial unique index for "one active job per
   repo".
5. **Ingestion triggers.** Scheduled incremental syncs, then webhook
   ingestion.
6. **An MCP server.** Expose the four read-only tools over MCP; their
   definitions are already provider-neutral.
7. **Bedrock.** A Bedrock client behind the `ModelRunner` interface, which is
   one class.
8. **A second provider.** GitLab, behind the ingestion interface.

## How I used AI

I built this with Claude Code and the superpowers workflow:

1. **Brainstorming.** This settled GitHub, the demo repositories and the
   trust-first framing.
2. **A written design spec** (`docs/superpowers/specs/`). A builder-check pass
   on it raised six questions, which are resolved in section 18.
3. **An 18-task implementation plan** (`docs/superpowers/plans/`).
4. **Task-by-task TDD.** Fresh subagents each took one task from a written
   brief. An independent reviewer then read every task's diff, and confirmed
   findings went through fix rounds.

A controller session kept an execution ledger. Each decision that changed the
spec or the plan was recorded there as a numbered ruling, together with its
cost if wrong. For example, R6 chose Nest 11 because Nest 12 is ESM-only, and
R8 added the scale floor. The ledger itself is not in the repo; the docs cite
the rulings where they matter.

I reviewed the design, the plan and every diff. The parts I would ask a
reviewer to read first are the grounding contract (what counts as a fact, the
per-unit tolerances), the calibration rules and the honesty of the eval
checks.

The per-task reviews and the real-API smoke tests caught bugs that one pass
would have shipped: an IQR-fallback false positive (R8), zero-filled
pre-coverage weeks read as an outlier (R10), a dedup rule that dropped the
reviewer's name (R13), a tool schema the live API rejected, and an SDK path
that turned refusals into 500s.

At runtime, the service calls the Claude API (Opus 5.5) for narratives. Real
API spend during the build was roughly $2: about $0.30 of smoke tests, plus
two full eval runs at $0.77 and $0.75. One smoke-test response shows the
effect of caching: a repeat with the prompt prefix cached read 14,220 tokens
from cache, made 3 tool calls, and cost $0.043 in 17 s.

## Trade-offs I would revisit

- **In-process runner.** It is correct for one instance only. Startup
  recovery fails every queued or running job, and "one active job per repo"
  rests on a row lock, not on a constraint.
- **Rule-based calibration.** The caps bound overconfidence. They do not make
  0.6 mean "right 60% of the time"; only outcome data can.
- **Deterministic eval grading.** It is exactly why the wrong causal story
  on `latency_spike` passes. A narrow LLM judge for cause attribution alone,
  anchored on human-checked cases, may be worth its drift.
- **One high-water mark per repository.** PRs and issues resume from
  `lastSyncedAt` by `updatedAt`. Commits resume from the previous coverage
  end, by committed date (R9), because GitHub cannot filter commit history by
  push time. Per-entity cursors would be cleaner.
- **Floor-clamped scale (R8).** It trades sensitivity on very stable series
  for no false alarms on near-flat counts. Per-metric floors tuned on real
  repositories would be better.
- **Entity-first dedup (R13).** It keeps the reviewer's name, but it can
  replace a `high` outlier with a `moderate` concentration signal on the same
  cell. Keeping and linking both signals may be better.

## Known limitations

- **History and commits.** Commits deleted by a force push are never pruned,
  and incremental syncs miss commits pushed late with old committed dates.
- **Cache scope.** The cache key covers signals, not every metric value. A
  re-sync that leaves the signals identical reuses the stored narrative until
  `refresh=true`.
- **Cost accounting.** `costUsd` uses Opus 5.5 list prices even when the
  fallback served the request. The eval records $0 for a failed run.
- **Prose check coverage.** The prose check covers only the headline and the
  narrative. Tokens like `1.2.3` yield spurious unverified numerals.
- **Day buckets.** They are allowed on any window up to 26 weeks.
- **Coverage hint.** The API reports partial coverage without an explicit
  "sync wider" hint; the page shows one.
- **Docker image size.** The image is about 715 MB, because the Prisma
  engines and `tsx` ship for in-container `db:seed`.

## Numbers verified

Pending: filled in by the live-sync step (Task 16) once a read-only GITHUB_TOKEN is available.

## Eval results

The baseline is `eval/reports/2026-10-29T05-17-04.490Z/`:

- prompt v1, `claude-opus-5-5`, effort `medium`;
- 6 cases with 3 runs each, and 0 failed runs;
- an estimated $0.75.

| Case | Schema and grounding | Names planted metric | Confidence ordering | Unverified numbers at most 2 | Mean top confidence | Mean cost |
|---|---|---|---|---|---|---|
| control | 100% | n/a | 100% | 100% | 0 (no hypotheses) | $0.016 |
| latency_spike | 100% | 100% | 100% | 33% | 0.57 | $0.064 |
| reviewer_dropout | 100% | 100% | 100% | 67% | 0.60 | $0.055 |
| throughput_shift | 100% | 100% | 100% | 100% | 0.55 | $0.066 |
| concentration | 100% | 100% | 100% | 33% | 0.63 | $0.039 |
| commit_only | 100% | n/a | 100% | 0% | 0 (no hypotheses) | $0.010 |

No evidence item was rejected in any of the 18 runs, and both control cases
returned zero hypotheses every time. The eval surfaced two findings.

1. **A plausible but wrong causal story on `latency_spike`.**
   - **What was planted.** A uniform 5x first-review latency in the week of
     2026-10-05, with reviewer assignment unchanged.
   - **What the model said.** In 6 of 6 runs across both evals, the top
     hypothesis blamed a one-week drop in bob's reviews. It cited bob's
     `reviews_given`, which is a correct, grounded number. That drop is a side
     effect of the plant: slower reviews push some of the week's reviews into
     the next week.
   - **Why the check passed.** The model cited the right metric and bucket,
     and `names_planted_metric` grades only that, not the causal story.
     `alternative_explanations` and `suggested_check` do hedge the claim, and
     confidence stayed around 0.55.
   - **What v2 changes.** A per-case cause-attribution expectation, such as
     "does not blame an entity".
2. **`commit_only` restates uncited numbers.** A run with zero hypotheses has
   zero evidence items, so every commit count in its prose is unverifiable:
   0 of 3 runs passed. The fix is prompt v2's "words, not numerals" rule.
   More broadly, the 56% overall pass rate shows that the model restates
   baseline medians and counts it never cited. That rate is reported, not
   gated, by design.

## Dependencies and audit

`npm audit --audit-level=high` runs in CI and passes. Two high-severity
transitive advisories are fixed with npm `overrides`:

| Override | Advisory | Pulled in by |
|---|---|---|
| `multer` `^2.5.0` | GHSA-q7qp-rjg7-q26m | `@nestjs/platform-express` |
| `deepmerge-ts` `^8.0.0` | GHSA-ggr8-5vv4-36mx (stack exhaustion on recursive objects) | `@prisma/config` |

The `deepmerge-ts` override is an unsupported combination:

- `@prisma/config` pins 7.1.5 in every Prisma 6.x release up to 6.19.3.
- It is only used for the Prisma CLI's config merging, never at request time.
- `prisma generate` and `migrate deploy` were verified with it.

I would remove both overrides once fixed releases ship.

Below the threshold, these remain:

- a moderate `js-yaml` advisory (GHSA-r3ph-w7gj-g6xm), through
  `@nestjs/swagger`, where the fix needs Swagger 12;
- a moderate `deepmerge` advisory;
- 8 low advisories.
