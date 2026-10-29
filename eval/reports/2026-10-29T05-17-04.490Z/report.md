# Eval report

- promptVersion: `v1`
- model: `claude-opus-5-5`
- effort: `medium`
- runs per case: 3
- date: 2026-10-29T05:17:04.490Z
- control mean top confidence: 0

Methodology: every check is deterministic (no model judge). `names_planted_metric` grades the top hypothesis (highest calibrated confidence): one evidence item must cite the planted metric (fact suffixes such as `.item` or `.observed` count) in the planted bucket, and the expected entity is matched across that hypothesis (the matching item, the signal it cites, or another evidence item), because ledger facts for signal metrics carry `entity: null` by design.

## Pass rates

| case | schema_and_grounding | names_planted_metric | confidence_ordering | unverified_numbers |
|---|---|---|---|---|
| control | 100% | n/a | 100% | 100% |
| latency_spike | 100% | 100% | 100% | 33% |
| reviewer_dropout | 100% | 100% | 100% | 67% |
| throughput_shift | 100% | 100% | 100% | 100% |
| concentration | 100% | 100% | 100% | 33% |
| commit_only | 100% | n/a | 100% | 0% |
| **overall** | **100%** | **100%** | **100%** | **56%** |

`unverified_numbers` is reported only; it does not affect the exit code. `n/a`: the check does not apply (no planted metric in a control case, or no control run to compare with).

## Cost and latency per case (means per run)

| case | top confidence | tokens in | tokens out | cache read | cache write | tool calls | latency (s) | cost | failed runs |
|---|---|---|---|---|---|---|---|---|---|
| control | 0 | 4 | 589 | 5586 | 536 | 0 | 7.7 | $0.0156 | 0 |
| latency_spike | 0.57 | 8 | 1944 | 25146 | 4004 | 5 | 21.3 | $0.0640 | 0 |
| reviewer_dropout | 0.6 | 7 | 1602 | 22957 | 3567 | 3.33 | 18.1 | $0.0545 | 0 |
| throughput_shift | 0.55 | 7 | 2024 | 26996 | 3995 | 4.33 | 20.1 | $0.0659 | 0 |
| concentration | 0.63 | 7 | 1271 | 19157 | 1996 | 3 | 15.4 | $0.0393 | 0 |
| commit_only | 0 | 4 | 355 | 5413 | 449 | 0 | 5.2 | $0.0104 | 0 |

**Totals:** 18 runs (0 failed), 112 input / 23355 output / 315765 cache-read / 43641 cache-write tokens, estimated cost $0.7489.

## Failures

- latency_spike run 1, unverified_numbers: 5: 6.29, 10, 15, 5.875, 3
- latency_spike run 3, unverified_numbers: 5: 29.89, 25, 38, 39, 3
- reviewer_dropout run 2, unverified_numbers: 5: 6, 25, 12, 6.383333333333333, 11.141666666666666
- concentration run 1, unverified_numbers: 3: 11, 12, 0.3408304498269896
- concentration run 2, unverified_numbers: 6: 20, 22, 40, 0.3408304498269896, 11, 16
- commit_only run 1, unverified_numbers: 8: 6, 21, 27, 4, 2, 53, 45, 42
- commit_only run 2, unverified_numbers: 8: 6, 21, 27, 4, 2, 53, 45, 42
- commit_only run 3, unverified_numbers: 8: 6, 21, 27, 4, 2, 53, 45, 42

## Detector signals per case

### control

seed 5; 205 PRs, 303 reviews, 42 issues, 191 commits; window 2026-08-31 to 2026-10-26

No signals.

### latency_spike

seed 1; 205 PRs, 308 reviews, 42 issues, 191 commits; window 2026-08-31 to 2026-10-26

| metric | bucket | detector | severity | observed | score |
|---|---|---|---|---|---|
| time_to_first_review_p50_h | 2026-10-05 | robust_outlier | high | 21.53 baseline=6.291666666666667 | 15.24 |
| time_to_merge_p50_h | 2026-10-05 | robust_outlier | moderate | 41.38 baseline=29.891666666666666 | 3.84 |
| issue_time_to_close_p50_h | 2026-10-19 | robust_outlier | moderate | 166.55 baseline=121.95833333333334 | 3.06 |
| prs_merged | 2026-10-05 | throughput_divergence | moderate | 17 baseline=21 | -1.9 |

### reviewer_dropout

seed 2; 205 PRs, 277 reviews, 42 issues, 191 commits; window 2026-08-31 to 2026-10-26

| metric | bucket | detector | severity | observed | score |
|---|---|---|---|---|---|
| time_to_first_review_p50_h | 2026-10-12 | level_shift | moderate | 10.62 baseline=6.383333333333333 | 4.24 |
| review_concentration_hhi | 2026-10-05 | robust_outlier | moderate | 0.54 baseline=0.33884297520661155 | 3.93 |
| time_to_first_review_p50_h | 2026-10-19 | robust_outlier | moderate | 11.14 baseline=6.625 | 3.77 |
| review_concentration_hhi | 2026-10-19 | robust_outlier | moderate | 0.51 baseline=0.33884297520661155 | 3.38 |
| review_concentration_hhi | 2026-10-12 | level_shift | moderate | 0.51 baseline=0.3387180030536674 | 3.35 |
| review_concentration_top1 | 2026-10-05 | review_concentration | moderate | 0.63 | 0.63 entity=carol |
| review_concentration_top1 | 2026-10-19 | review_concentration | moderate | 0.56 | 0.56 entity=carol |
| review_concentration_top1 | 2026-10-12 | review_concentration | moderate | 0.55 | 0.55 entity=carol |

### throughput_shift

seed 3; 206 PRs, 293 reviews, 42 issues, 147 commits; window 2026-08-31 to 2026-10-26

| metric | bucket | detector | severity | observed | score |
|---|---|---|---|---|---|
| prs_merged | 2026-10-12 | level_shift | high | 9.5 baseline=20.5 | -5.37 |
| prs_merged | 2026-10-05 | throughput_divergence | high | 8 baseline=20 | -4.05 |
| prs_merged | 2026-10-19 | throughput_divergence | high | 9 baseline=20 | -3.71 |
| prs_merged | 2026-09-28 | throughput_divergence | high | 12 baseline=20 | -2.7 |
| commits | 2026-10-12 | level_shift | moderate | 12.5 baseline=23.5 | -4.68 |
| commits | 2026-10-05 | robust_outlier | moderate | 11 baseline=23 | -4.05 |
| commits | 2026-10-19 | robust_outlier | moderate | 12 baseline=23 | -3.71 |
| prs_closed_unmerged | 2026-10-12 | level_shift | moderate | 5 baseline=1 | 3.6 |

### concentration

seed 4; 207 PRs, 307 reviews, 41 issues, 193 commits; window 2026-08-31 to 2026-10-26

| metric | bucket | detector | severity | observed | score |
|---|---|---|---|---|---|
| review_concentration_hhi | 2026-09-28 | robust_outlier | high | 0.66 baseline=0.3408304498269896 | 6.41 |
| review_concentration_top1 | 2026-09-28 | review_concentration | high | 0.8 | 0.8 entity=alice |

### commit_only

seed 6; 0 PRs, 0 reviews, 0 issues, 193 commits; window 2026-08-31 to 2026-10-26

No signals.
