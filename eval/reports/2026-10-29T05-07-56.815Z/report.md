# Eval report

- promptVersion: `v1`
- model: `claude-opus-5-5`
- effort: `medium`
- runs per case: 3
- date: 2026-10-29T05:07:56.815Z
- control mean top confidence: 0

## Pass rates

| case | schema_and_grounding | names_planted_metric | confidence_ordering | unverified_numbers |
|---|---|---|---|---|
| control | 100% | n/a | 100% | 100% |
| latency_spike | 100% | 100% | 100% | 33% |
| reviewer_dropout | 100% | 100% | 100% | 67% |
| throughput_shift | 100% | 100% | 100% | 100% |
| concentration | 100% | 100% | 100% | 33% |
| commit_only | 100% | n/a | 100% | 33% |
| **overall** | **100%** | **100%** | **100%** | **61%** |

`unverified_numbers` is reported only; it does not affect the exit code. `n/a`: the check does not apply (no planted metric in a control case, or no control run to compare with).

## Cost and latency per case (means per run)

| case | top confidence | tokens in | tokens out | cache read | cache write | tool calls | latency (s) | cost | failed runs |
|---|---|---|---|---|---|---|---|---|---|
| control | 0 | 4 | 599 | 4081 | 2041 | 0 | 8.3 | $0.0230 | 0 |
| latency_spike | 0.58 | 7 | 1824 | 21889 | 3426 | 4 | 20.2 | $0.0580 | 0 |
| reviewer_dropout | 0.6 | 7 | 1409 | 23356 | 3646 | 3.33 | 16.5 | $0.0511 | 0 |
| throughput_shift | 0.52 | 8 | 2064 | 30981 | 4087 | 4.67 | 21.3 | $0.0679 | 0 |
| concentration | 0.67 | 6 | 1400 | 13550 | 2911 | 3.67 | 15.3 | $0.0453 | 0 |
| commit_only | 0 | 4 | 435 | 5413 | 449 | 0 | 5.5 | $0.0120 | 0 |

**Totals:** 18 runs (0 failed), 108 input / 23190 output / 297811 cache-read / 49679 cache-write tokens, estimated cost $0.7722.

## Failures

- latency_spike run 1, unverified_numbers: 7: 6.29, 41.38, 17, 2, 45, 166.55, 3
- latency_spike run 2, unverified_numbers: 3: 29.89, 25, 38
- reviewer_dropout run 3, unverified_numbers: 6: 10, 12, 17, 18, 6.38, 23
- concentration run 1, unverified_numbers: 3: 0.66125, 16, 21
- concentration run 2, unverified_numbers: 4: 40, 0.38, 0.43243243243243246, 25
- commit_only run 2, unverified_numbers: 7: 6, 21, 27, 2, 53, 45, 42
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
| review_concentration_top1 | 2026-10-05 | robust_outlier | moderate | 0.63 baseline=0.3939393939393939 | 4.79 |
| time_to_first_review_p50_h | 2026-10-12 | level_shift | moderate | 10.62 baseline=6.383333333333333 | 4.24 |
| review_concentration_hhi | 2026-10-05 | robust_outlier | moderate | 0.54 baseline=0.33884297520661155 | 3.93 |
| time_to_first_review_p50_h | 2026-10-19 | robust_outlier | moderate | 11.14 baseline=6.625 | 3.77 |
| review_concentration_hhi | 2026-10-19 | robust_outlier | moderate | 0.51 baseline=0.33884297520661155 | 3.38 |
| review_concentration_top1 | 2026-10-19 | robust_outlier | moderate | 0.56 baseline=0.3939393939393939 | 3.37 |
| review_concentration_hhi | 2026-10-12 | level_shift | moderate | 0.51 baseline=0.3387180030536674 | 3.35 |
| review_concentration_top1 | 2026-10-12 | level_shift | moderate | 0.56 baseline=0.3892773892773893 | 3.32 |

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
| review_concentration_top1 | 2026-09-28 | robust_outlier | high | 0.8 baseline=0.38235294117647056 | 8.35 |
| review_concentration_hhi | 2026-09-28 | robust_outlier | high | 0.66 baseline=0.3408304498269896 | 6.41 |

### commit_only

seed 6; 0 PRs, 0 reviews, 0 issues, 193 commits; window 2026-08-31 to 2026-10-26

No signals.
