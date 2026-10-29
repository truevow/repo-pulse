# Metrics, detectors, grounding and calibration

This is the reference for every number Repo Pulse computes and every rule that
acts on those numbers. It describes the code as it is. Where the code differs
from the design spec (`docs/superpowers/specs/2026-10-28-repo-pulse-design.md`),
the difference and the reason for it are stated. The reasons come from rulings
recorded during the build.

Source files: `src/signals/metrics.sql.ts`, `src/signals/metrics.repository.ts`,
`src/signals/detectors/*`, `src/signals/signal.types.ts`,
`src/synthesis/fact-ledger.ts`, `src/synthesis/grounding.ts`,
`src/synthesis/calibration.ts`, `src/synthesis/cache-key.ts`,
`src/synthesis/narrative.service.ts`.

## Windows and buckets

- A window is half-open, `[from, to)`. Both ends are UTC midnight. `from` and
  `to` are ISO dates (`YYYY-MM-DD`), and `to` is exclusive.
- The default window is the last 8 complete ISO weeks. It ends at Monday
  00:00 UTC of the current week.
- A window may not exceed `SYNC_MAX_WEEKS` (26). `from` must come before `to`,
  and `to` may not be in the future. Any violation is a 400.
- Buckets are ISO weeks (Monday start, the default) or UTC days. Each bucket
  is keyed by its start date. The SQL groups rows with
  `date_trunc('week'|'day', ts AT TIME ZONE 'UTC')` over a `generate_series` of
  bucket starts, so empty buckets are still returned.
- When an explicit window cuts a bucket, that edge bucket is still returned,
  with `partial: true`.
- Each metric is counted on the timestamp that defines it:
  - "opened" metrics use `createdAt`;
  - merge metrics use `mergedAt`;
  - close metrics use `closedAt`;
  - review metrics use `submittedAt`;
  - first-review latency uses the timestamp of the first counted review;
  - commit metrics use `committedDate`.

Counting rules that apply everywhere:

- **Reviews.** `PENDING` reviews are ignored. `DISMISSED` reviews count as
  submitted. Self-reviews (reviewer is the PR author) are excluded from every
  review metric, from the review examples and from the reviewers leaderboard.
- **Bots.** A bot is an actor whose GraphQL `__typename` is `Bot`, or whose
  login ends in `[bot]`.
  - With `includeBots=false` (the default), bot reviews are excluded from
    every review metric, and bots are excluded from all three leaderboards.
  - PR, issue and commit counts always include bots. So do `active_authors`
    and `bus_factor_50`.
- **Unlinked commits.** A commit whose author has no GitHub account is
  attributed to its author name. Each distinct name counts as one author.
- **Unavailable entities.** Pull requests are `unavailable` when the
  repository has no pull requests at all (GitHub's `pullRequests.totalCount`
  is 0 at sync time). Issues are `unavailable` when issues are disabled
  (`hasIssuesEnabled` is false). Either way, those metrics are `null` (not 0),
  and `availability` says `unavailable`.
- **Empty buckets.** Count metrics are `0` in an empty bucket. Medians and
  ratios are `null` when there is nothing to take a median or share of.
  `bus_factor_50` is `null` when a bucket has no commits.

## The 15 metrics

| Metric | Unit | Definition | Why it matters |
|---|---|---|---|
| `prs_opened` | count | PRs created in the bucket | Demand on the review pipeline. It is the denominator for whether merges keep up. |
| `prs_merged` | count | PRs merged in the bucket | Delivered throughput. A drop while `prs_opened` holds steady means a backlog is growing. |
| `prs_closed_unmerged` | count | PRs closed without merge in the bucket | Abandoned or rejected work. A rise can mean churn, a reprioritisation or a cleanup. |
| `time_to_first_review_p50_h` | hours | Median hours from PR creation to the first non-author review, for PRs whose first review landed in the bucket | The wait an author feels most directly, and the first sign that reviewers are overloaded or away. |
| `time_to_merge_p50_h` | hours | Median hours from PR creation to merge, for PRs merged in the bucket | End-to-end cycle time. It separates "slow to start" from "slow to finish" when read next to first-review latency. |
| `reviews_submitted` | count | Non-author reviews submitted in the bucket | Review capacity actually spent. |
| `approvals` | count | Non-author reviews with state `APPROVED` in the bucket | The part of review effort that unblocks merges. |
| `review_concentration_top1` | ratio | Share of the bucket's non-author reviews submitted by the single busiest reviewer | Review load resting on one person is a bottleneck and a key-person risk. |
| `review_concentration_hhi` | ratio | Herfindahl index of review shares across reviewers (sum of squared shares, 0 to 1) | Concentration across the whole reviewer pool, not only the top person. |
| `issues_opened` | count | Issues created in the bucket | Incoming reports and requests. |
| `issues_closed` | count | Issues closed in the bucket | Issue resolution throughput. |
| `issue_time_to_close_p50_h` | hours | Median hours open for issues closed in the bucket | How long reported problems wait. It is noisy when only a few issues close. |
| `commits` | count | Commits on the default branch in the bucket | Raw activity on the main line, including direct pushes that bypass PRs. |
| `active_authors` | count | Distinct commit authors in the bucket | Team size actually contributing that week. |
| `bus_factor_50` | count | Smallest number of authors whose commits cover at least 50% of the bucket's commits | How few people carry the work. A value of 1 means one person wrote half of everything. |

Leaderboards cover the whole window, and each holds the top 20:

- **contributors**: `mergedPrs`, `commits`, `linesChanged` (commit additions
  plus deletions), ordered by merged PRs;
- **reviewers**: `reviews`, `approvals`;
- **mergers**: `prsMerged`, from the PR's `mergedBy`.

"Top issue closers" was dropped. GitHub exposes who closed an issue only
through timeline events, which would cost one extra nested connection per
issue.

### Example items per metric

Each signal carries up to 5 `examples`, the items behind the bucket's value.
The value of each example is in the unit shown below.

| Metric | Examples |
|---|---|
| `time_to_first_review_p50_h` | PRs whose first review landed in the bucket, slowest first (hours) |
| `time_to_merge_p50_h` | PRs merged in the bucket, slowest first (hours) |
| `prs_opened`, `prs_merged`, `prs_closed_unmerged` | PRs in that state in the bucket, largest first (lines) |
| `reviews_submitted`, `approvals` | PRs with the most counted reviews (or approvals) in the bucket (count) |
| `review_concentration_*` | The same, filtered to the named reviewer when the signal has an entity (count) |
| `issues_opened` | Newest issues in the bucket (age in hours at window end) |
| `issues_closed`, `issue_time_to_close_p50_h` | Issues closed in the bucket, longest open first (hours) |
| `commits`, `active_authors`, `bus_factor_50` | Largest commits in the bucket (lines). Commit messages are not stored, so the title is the short sha. |

## Detectors

Detectors are pure functions over a metric series. Their thresholds live in
one object, `DETECTOR_PARAMETERS` in `src/signals/signal.types.ts`. Every
insights response echoes that object under `parameters`.

| Parameter | Value |
|---|---|
| `outlierZ` (flag threshold, outlier and level shift) | 3 |
| `highSeverityZ` | 5 |
| `minBaseline` (complete baseline buckets) | 4 |
| `levelShiftRecentBuckets` | week 2, day 7 |
| `concentrationTop1Share` | 0.5 |
| `concentrationMinReviews` | 10 |
| `concentrationHighShare` | 0.75 |
| `divergenceScaleUnits` | 1 |
| `divergenceHighScaleUnits` | 2 |

### Which buckets are scored

A point can be scored, or used in a baseline, only when it is complete: not
partial, and with a non-null value. Two kinds of bucket count as partial for
the detectors:

- **Window-edge buckets** cut by an explicit `from` or `to`.
- **Buckets outside the synced coverage range** (ruling R10). Before coverage
  begins, the database is simply empty, so the SQL returns zeros for those
  weeks. In the first insights run, those zeros produced a false `commits`
  outlier.

The response's `buckets[].partial` flag reflects window edges only. A
separate `buckets[].covered` flag is true when the bucket's in-window span
lies inside `[coverage.from, coverage.to)`. An uncovered bucket was never
synced, so every one of its metrics is `null` in the response, never a zero.
Everything downstream treats it as "no data":

- the user message renders the row as `<key>!` with `-` in every cell, and
  the system prompt explains the `!` marker;
- `get_metric_series` returns `value: null, covered: false` for it and
  records nothing;
- `get_bucket_examples` refuses it with `{"error": "bucket_not_synced"}`:
  the only rows there are stragglers fetched for a later window (a PR
  created before coverage but updated inside it);
- `get_contributor_activity` returns its row with `covered: false` and null
  counts, and records nothing for it;
- `compare_windows` skips it, as it skips partial buckets;
- the fact ledger seeds nothing from it;
- the demo page marks its column header with `!`.

### Robust baseline (shared)

For a list of baseline values:

```
median = type-7 (linear) quantile at 0.5
candidate = 1.4826 × MAD            if MAD > 0     (scaleSource "mad")
          = IQR / 1.349             otherwise      (scaleSource "iqr")
floor = max(1,    0.1 × |median|)   for count, hours and lines metrics
        max(0.05, 0.1 × |median|)   for ratio metrics
scale = max(candidate, floor)       (scaleSource "floor" when the floor wins)
```

**Spec difference (ruling R8).** In the spec, the floor was used only when
both MAD and IQR were zero. The code instead clamps every scale from below by
the floor. The reason is a false positive: on near-flat integer series, the
IQR fallback produced scales such as 0.37, so a 14 among a run of 15s was
flagged `high`. A false signal would also feed the narrative. The cost is
slightly lower sensitivity on very stable series. `baseline.scaleSource`
shows which source won. In the latency fixture, the spike baseline reads
`{"median": 6.29, "scale": 1, "n": 7, "scaleSource": "floor"}`.

### 1. Robust outlier (`robust_outlier`)

This detector runs on every available metric and every complete bucket.

- **Baseline:** all other complete buckets of the series (leave-one-out). It
  needs at least 4, so the series needs at least 5 complete points.
- **Score:** `z = (x − median) / scale`.
- **Flag:** when `|z| ≥ 3`.
- **Severity:** `high` when `|z| > 5`, otherwise `moderate`.
- **Direction:** the sign of `z`.

Example, from the `latency_spike` fixture:

> time_to_first_review_p50_h was 21.53 in 2026-10-05, versus a typical 6.29 (robust z 15.24)

### 2. Level shift (`level_shift`)

This detector runs on every available metric and produces at most one signal
per metric.

- **Recent buckets:** the last k complete buckets, with k = 2 for weeks and
  k = 7 for days.
- **Baseline:** the robust baseline of all earlier complete buckets. It needs
  at least 4.
- **Score:** `(median(recent) − median) / scale`. The same threshold and
  severity apply as for the outlier detector.
- **Signal fields:** the signal's bucket is the first recent bucket, and
  `observed` is the median of the recent buckets, not a single cell.

Example, from `throughput_shift`:

> prs_merged moved from a typical 20.5 to 9.5 over the last 2 buckets

### 3. Review concentration (`review_concentration`)

This detector runs on `review_concentration_top1` in each complete bucket. It
flags a bucket when:

- at least 10 reviews were submitted;
- the busiest reviewer's share is at least 0.5;
- that reviewer is known.

Ties for busiest go to the first login in byte order.

The signal's fields are set as follows:

| Field | Value |
|---|---|
| `score` | The share |
| `baseline` | `null` |
| `entity` | The reviewer's login |
| `severity` | `high` when the share is at least 0.75, otherwise `moderate` |

Example, from `concentration`:

> alice submitted 80% of 40 reviews in 2026-09-28

### 4. Throughput divergence (`throughput_divergence`)

This detector runs on `prs_merged`, in each complete bucket where both
`prs_opened` and `prs_merged` exist. Each series gets its own leave-one-out
count baseline, and both need at least 4 points.

A bucket is flagged when both of these hold:

- **Opened held:** `|opened − median_opened| ≤ 1 × scale_opened`.
- **Merges fell:** `median_merged − merged ≥ 1 × scale_merged`.

The signal's fields:

- **Score:** `(merged − median_merged) / scale_merged`, which is negative.
- **Severity:** `high` when the drop is at least 2 scale units, otherwise
  `moderate`.

**Spec difference (ruling R18).** The spec says opened must be "at or above its baseline".
The code requires opened to stay within one scale unit of its median, on
either side. That reads "kept being opened at the usual rate while merges
fell". A surge in openings is left to the outlier detector on `prs_opened`.

Example, from `throughput_shift`:

> PRs opened held at 25 while merges fell to 8 in 2026-10-05

### Deduplication and ordering (ruling R13)

Only one signal is kept per `(metric, bucket)`. The winner is decided by these
tie-breaks, in order:

1. A signal that names an entity.
2. A larger `|score|`.
3. Higher severity.
4. The more specific detector: divergence, then concentration, then level
   shift, then outlier.

Rule 1 was added after the first eval run. A concentration share (at most 1)
always lost to the outlier z-score (at least 3) on the same cell. That dropped
the reviewer's name, which is the point of the concentration detector. The
known side effect is that the surviving signal can carry a lower severity than
the outlier it replaced.

Signals are then sorted with `high` first, and by `|score|` descending within
each severity. A signal `id` is the first 12 hex characters of
`sha1("<detector>|<metric>|<bucket>")`, so it is stable across requests.

## Grounding

The model's structured output contains hypotheses, and each hypothesis holds
evidence items: `{signal_id, metric, bucket, entity, value, note}`. Each item
is checked deterministically against a per-request `FactLedger`, which holds
every number the model was shown.

### Ledger keys

A key is `(metric, bucket or null, entity or null)`. Entities are lower-cased.
When a key is written twice, the later write wins.

| Source | metric | bucket | entity |
|---|---|---|---|
| Insights bucket cell (and `get_metric_series`), covered buckets only | metric name | bucket key | null |
| Contributors leaderboard, top 10 rows | `merged_prs`, `commits`, `lines_changed` | null | login |
| Reviewers leaderboard, top 10 rows | `reviews`, `approvals` | null | login |
| Mergers leaderboard, top 10 rows | `prs_merged_by` | null | login |
| Signal observed value | metric name (the cell is written only if absent or equal) | signal bucket | null |
| Level-shift observed (recent median) | `<metric>.observed` | signal bucket | null |
| Signal baseline median | `<metric>.baseline_median` | signal bucket | null |
| Signal example, or a `get_bucket_examples` item | `<metric>.item` | bucket | item ref (`#123`, short sha) |
| `get_contributor_activity` | `prs_opened`, `prs_merged`, `reviews_given`, `commits` | bucket key | login |
| `compare_windows` | `<metric>.median`, `.mean`, `.total`, `.n` | `"<from>/<to>"` | null |
| `compare_windows` delta | `<metric>.delta_median` | `"<a.from>/<a.to>\|<b.from>/<b.to>"` | null |

Signal facts always carry `entity = null`, even when the signal names a
person, and the system prompt says so explicitly. A person's numbers are
cited through the leaderboards or `get_contributor_activity`.

The insights response lists up to 20 rows per leaderboard, but the user
message shows only the top 10, so only those 10 are seeded: a row the model
was never shown is not a fact. `get_contributor_activity` resolves the login
case-insensitively to the stored login and records cells under that login.
A login with no actor row returns `{"error": "unknown_login", "login": ...}`
and records nothing, so an unknown person never yields a series of grounded
zeros.

### Evidence checks (in order)

1. If `signal_id` is set but matches no signal in the response, the item is
   rejected as `unknown_signal`.
2. If the `(metric, bucket, entity)` key is not in the ledger, the item is
   rejected as `unknown_fact`.
3. If `|value − fact| > tolerance`, the item is rejected as `value_mismatch`,
   with `expected` set to the fact.

The tolerance depends on the fact's unit:

| Unit | Tolerance (absolute) |
|---|---|
| count, hours, lines | 0.5 |
| ratio | 0.01 |

Each rejected item is listed under `grounding.rejected`, with the index of its
hypothesis and the reason. A hypothesis with no surviving evidence is dropped,
and `grounding.droppedHypotheses` counts the drops.

### Status

| Status | Meaning |
|---|---|
| `ok` | Nothing rejected and nothing dropped. This includes a model that correctly returned zero hypotheses. |
| `partial` | Something was rejected or dropped, but at least one hypothesis survived. |
| `failed` | The model returned hypotheses and none survived. The response is still 200, with the narrative, an empty hypotheses list and this status. |

### Soft prose check

This check is a flag, never a rejection. It works in four steps:

1. **Extract numerals.** Numerals are taken from the headline and the
   narrative, after masking:
   - dates, ISO timestamps and ISO week labels;
   - `#123` refs and ordinals;
   - thousands separators.
   A percentage yields both `n` and `n/100`.
2. **Compare with evidence.** Each numeral is compared with the ledger values
   of the surviving evidence. It matches a ratio fact when it is within 0.005,
   equals the fact rounded to one decimal, or is within 0.5 of 100 × the fact.
   It matches any other fact when it is within 0.5, or equals the fact rounded
   to 0 or 1 decimals.
3. **List the misses.** Numerals that match nothing are listed once each under
   `grounding.unverifiedNumbers`.
4. **Keep the prose.** The narrative itself is not changed.

Rejecting or rewriting prose would cost more than it adds. The eval reports
the unverified rate, so the number stays visible.

## Calibration

Final confidence starts from the model's self-reported confidence. The rules
below are applied in order to the surviving evidence. Each rule is recorded in
`adjustments` only when it changed the value.

| # | Adjustment | Condition | Effect |
|---|---|---|---|
| 1 | `few_evidence_items` | Fewer than 2 surviving evidence items | Cap at 0.4 |
| 2 | `no_signal_cited` | No surviving item backs a detector signal (see below) | Cap at 0.5 |
| 3 | `moderate_signal_only` | Signals are cited and every cited signal is `moderate` | Cap at 0.6 |
| 4 | `evidence_rejected` | Grounding rejected at least one item of this hypothesis | Multiply by 0.8 |
| 5 | `partial_data` | `coverage.partial`, or pull requests or issues are unavailable | Cap at 0.5 |

The result is rounded to two decimals. The response carries both
`model_confidence` and `confidence`. Rules 2 and 3 are mutually exclusive, so
their order does not matter. This is a rule-based proxy for calibration, not a
calibrated probability (see NOTES.md).

- **Which items back a signal (rules 2 and 3).** An item counts as citing a
  signal only when its `signal_id` resolves, its base metric (the part before
  the first `.`, so `<metric>.item` and `<metric>.baseline_median` count)
  equals the signal's metric, and its bucket equals the signal's bucket. An
  item with a null bucket never backs a signal. Without this, the model could
  lift the cap by attaching a real signal id to an unrelated fact. Grounding
  stays lenient: such an item is not rejected (its id is known and its fact
  checks out), it just earns no signal credit.
- **`partial_data` is global.** `coverage.partial` and an unavailable pull
  request or issue source cap every hypothesis in the response, not only
  hypotheses whose evidence touches the missing entity (the spec's "required
  entity" reading). A hypothesis that cites only commit facts can still be
  wrong because of what it could not see, such as PR activity that explains a
  commit drop, and deciding which entities a causal claim depends on would
  need a judgement the deterministic layer cannot make. The simpler rule
  errs toward lower confidence.

## Narrative cache key

```
key = sha256(JSON.stringify([
  owner.toLowerCase(), repo.toLowerCase(),
  window.from, window.to,          // resolved ISO timestamps, not the raw query
  bucket, includeBots,
  signalsFingerprint,              // sha256 of the sorted "id:observed" list
  dataFingerprint,                 // sha256 of the user message (buildUserMessage)
  coverage.lastSyncedAt,           // start of the last successful sync, or null
  PROMPT_VERSION, ANTHROPIC_MODEL, ANTHROPIC_EFFORT,
]))
```

The parts are encoded as a fixed-order JSON array, so no part can bleed into
the next.

- **Hits and refresh.** A hit returns the stored response with
  `cached: true`. `refresh=true` skips the lookup and overwrites the row.
- **Concurrent requests.** Identical concurrent misses share one in-flight
  generation.
- **What the key covers.** `dataFingerprint` covers everything the model is
  shown up front: every cell, leaderboard row, signal, example, coverage and
  availability line. Tool results read Postgres, which changes through
  syncs, so `lastSyncedAt` covers them: any successful sync, even one that
  changes nothing, yields a new key.

## 409 and partial-coverage rules

- **409 `no-signal-data` (ruling R11).** The 409 fires before any cache
  lookup or model call, in either of two cases:
  - every entity in `availability` is unavailable;
  - no bucket holds a metric that is both non-null and non-zero.

  The spec's rule ("all metrics null") could never fire, because count metrics
  are 0, not null, in empty buckets. Commits are always available, so in
  practice the 409 means the window has no activity at all.
- **Partial coverage.** Insights and narrative never trigger a sync. Coverage
  is partial when:
  - the repository has never been synced;
  - `from` is before `coveredFrom`;
  - `to` is after `coveredTo`.

  On partial coverage, the response still answers with `coverage.partial:
  true` and the covered range. Uncovered buckets carry `covered: false` and
  null metrics (see "Which buckets are scored"), the detectors, tools and
  ledger skip them (R10), and calibration caps every hypothesis at 0.5. The
  demo page shows a warning.
  The API itself returns the covered range but no explicit "run a wider sync"
  hint.
