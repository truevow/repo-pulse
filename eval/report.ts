import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Detector, Severity } from '../src/signals/signal.types';
import type { CalibratedHypothesis } from '../src/synthesis/calibration';
import type {
  NarrativeResponse,
  NarrativeUsage,
} from '../src/synthesis/narrative.types';
import type { EvalExpectation } from './cases';
import { CHECKS, round2, type CheckName, type CheckResults } from './checks';
import type { Perturbation } from './fixtures/synthetic';

export interface SignalSummary {
  id: string;
  detector: Detector;
  metric: string;
  bucket: string;
  entity: string | null;
  observed: number;
  baselineMedian: number | null;
  score: number;
  severity: Severity;
}

export interface RunRecord {
  run: number;
  ok: boolean;
  /** Set when the call raised; `type` is the problem type (e.g. synthesis-failed). */
  problem: { status: number | null; type: string; detail: string } | null;
  /** Wall clock of the getNarrative call. */
  latencyMs: number;
  /** The service's own generation time (meta.latencyMs). */
  generationMs: number | null;
  toolCalls: number;
  turns: number;
  model: string | null;
  /** Zero for failed runs: the service does not report usage when it throws. */
  usage: NarrativeUsage;
  topConfidence: number | null;
  headline: string | null;
  narrative: string | null;
  hypotheses: CalibratedHypothesis[];
  dataCaveats: string[];
  grounding: NarrativeResponse['grounding'] | null;
  checks: CheckResults | null;
}

export interface CaseRecord {
  name: string;
  expect: EvalExpectation;
  seed: number;
  perturbations: Perturbation[];
  snapshot: {
    pullRequests: number;
    reviews: number;
    issues: number;
    commits: number;
  };
  window: { from: string; to: string };
  signals: SignalSummary[];
  runs: RunRecord[];
}

export interface CaseSummary {
  name: string;
  passRates: Record<CheckName, number | null>;
  meanTopConfidence: number | null;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanCacheReadTokens: number;
  meanCacheWriteTokens: number;
  meanLatencyMs: number;
  meanToolCalls: number;
  meanCostUsd: number;
  totalCostUsd: number;
  failedRuns: number;
}

export interface Failure {
  case: string;
  run: number;
  check: CheckName;
  reason: string;
}

export interface EvalReport {
  promptVersion: string;
  model: string;
  effort: string;
  runs: number;
  date: string;
  dry: boolean;
  caseFilter: string | null;
  controlMeanTopConfidence: number | null;
  summaries: CaseSummary[];
  totals: {
    runs: number;
    failedRuns: number;
    passRates: Record<CheckName, number | null>;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  };
  failures: Failure[];
  cases: CaseRecord[];
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/** Share of runs where the check passed, over runs where it applies. */
function passRate(runs: RunRecord[], check: CheckName): number | null {
  const applicable = runs.flatMap((r) => {
    const pass = r.checks?.[check].pass;
    return pass === undefined || pass === null ? [] : [pass];
  });
  return applicable.length === 0
    ? null
    : round2(applicable.filter(Boolean).length / applicable.length);
}

function passRates(runs: RunRecord[]): Record<CheckName, number | null> {
  return Object.fromEntries(
    CHECKS.map((c) => [c, passRate(runs, c)]),
  ) as Record<CheckName, number | null>;
}

function summarize(c: CaseRecord): CaseSummary {
  const ok = c.runs.filter((r) => r.ok);
  const all = c.runs;
  return {
    name: c.name,
    passRates: passRates(all),
    meanTopConfidence:
      ok.length === 0
        ? null
        : round2(mean(ok.map((r) => r.topConfidence ?? 0))),
    meanInputTokens: Math.round(mean(all.map((r) => r.usage.inputTokens))),
    meanOutputTokens: Math.round(mean(all.map((r) => r.usage.outputTokens))),
    meanCacheReadTokens: Math.round(
      mean(all.map((r) => r.usage.cacheReadTokens)),
    ),
    meanCacheWriteTokens: Math.round(
      mean(all.map((r) => r.usage.cacheWriteTokens)),
    ),
    meanLatencyMs: Math.round(mean(all.map((r) => r.latencyMs))),
    meanToolCalls: round2(mean(all.map((r) => r.toolCalls))),
    meanCostUsd: round6(mean(all.map((r) => r.usage.costUsd))),
    totalCostUsd: round6(sum(all.map((r) => r.usage.costUsd))),
    failedRuns: all.length - ok.length,
  };
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export function buildReport(input: {
  promptVersion: string;
  model: string;
  effort: string;
  runs: number;
  date: Date;
  dry: boolean;
  caseFilter: string | null;
  controlMeanTopConfidence: number | null;
  cases: CaseRecord[];
}): EvalReport {
  const allRuns = input.cases.flatMap((c) => c.runs);
  const failures: Failure[] = input.cases.flatMap((c) =>
    c.runs.flatMap((r) =>
      CHECKS.flatMap((check): Failure[] =>
        r.checks && r.checks[check].pass === false
          ? [
              {
                case: c.name,
                run: r.run,
                check,
                reason: r.checks[check].reason,
              },
            ]
          : [],
      ),
    ),
  );
  return {
    promptVersion: input.promptVersion,
    model: input.model,
    effort: input.effort,
    runs: input.runs,
    date: input.date.toISOString(),
    dry: input.dry,
    caseFilter: input.caseFilter,
    controlMeanTopConfidence:
      input.controlMeanTopConfidence === null
        ? null
        : round2(input.controlMeanTopConfidence),
    summaries: input.cases.map(summarize),
    totals: {
      runs: allRuns.length,
      failedRuns: allRuns.filter((r) => !r.ok).length,
      passRates: passRates(allRuns),
      inputTokens: sum(allRuns.map((r) => r.usage.inputTokens)),
      outputTokens: sum(allRuns.map((r) => r.usage.outputTokens)),
      cacheReadTokens: sum(allRuns.map((r) => r.usage.cacheReadTokens)),
      cacheWriteTokens: sum(allRuns.map((r) => r.usage.cacheWriteTokens)),
      costUsd: round6(sum(allRuns.map((r) => r.usage.costUsd))),
    },
    failures,
    cases: input.cases,
  };
}

const pct = (x: number | null): string =>
  x === null ? 'n/a' : `${Math.round(x * 100)}%`;
const usd = (x: number): string => `$${x.toFixed(4)}`;
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function signalLine(s: SignalSummary): string {
  const entity = s.entity ? ` entity=${s.entity}` : '';
  const base = s.baselineMedian === null ? '' : ` baseline=${s.baselineMedian}`;
  return `| ${s.metric} | ${s.bucket} | ${s.detector} | ${s.severity} | ${round2(s.observed)}${base} | ${round2(s.score)}${entity} |`;
}

export function renderMarkdown(r: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# Eval report${r.dry ? ' (dry run)' : ''}`, '');
  lines.push(
    `- promptVersion: \`${r.promptVersion}\``,
    `- model: \`${r.model}\``,
    `- effort: \`${r.effort}\``,
    `- runs per case: ${r.dry ? 0 : r.runs}`,
    `- date: ${r.date}`,
  );
  if (r.caseFilter) lines.push(`- case filter: \`${r.caseFilter}\``);
  if (!r.dry) {
    lines.push(
      `- control mean top confidence: ${r.controlMeanTopConfidence ?? 'n/a (control not run)'}`,
    );
  }
  lines.push(
    '',
    'Methodology: every check is deterministic (no model judge). `names_planted_metric` grades the top hypothesis (highest calibrated confidence): one evidence item must cite the planted metric (fact suffixes such as `.item` or `.observed` count) in the planted bucket, and the expected entity is matched across that hypothesis (the matching item, the signal it cites, or another evidence item), because ledger facts for signal metrics carry `entity: null` by design.',
  );
  lines.push('');

  if (!r.dry) {
    lines.push('## Pass rates', '');
    lines.push(`| case | ${CHECKS.join(' | ')} |`);
    lines.push(`|---|${CHECKS.map(() => '---').join('|')}|`);
    for (const s of r.summaries) {
      lines.push(
        `| ${s.name} | ${CHECKS.map((c) => pct(s.passRates[c])).join(' | ')} |`,
      );
    }
    lines.push(
      `| **overall** | ${CHECKS.map((c) => `**${pct(r.totals.passRates[c])}**`).join(' | ')} |`,
      '',
      '`unverified_numbers` is reported only; it does not affect the exit code. `n/a`: the check does not apply (no planted metric in a control case, or no control run to compare with).',
      '',
    );

    lines.push('## Cost and latency per case (means per run)', '');
    lines.push(
      '| case | top confidence | tokens in | tokens out | cache read | cache write | tool calls | latency (s) | cost | failed runs |',
    );
    lines.push('|---|---|---|---|---|---|---|---|---|---|');
    for (const s of r.summaries) {
      lines.push(
        `| ${s.name} | ${s.meanTopConfidence ?? 'n/a'} | ${s.meanInputTokens} | ${s.meanOutputTokens} | ${s.meanCacheReadTokens} | ${s.meanCacheWriteTokens} | ${s.meanToolCalls} | ${(s.meanLatencyMs / 1000).toFixed(1)} | ${usd(s.meanCostUsd)} | ${s.failedRuns} |`,
      );
    }
    const t = r.totals;
    lines.push(
      '',
      `**Totals:** ${t.runs} runs (${t.failedRuns} failed), ${t.inputTokens} input / ${t.outputTokens} output / ${t.cacheReadTokens} cache-read / ${t.cacheWriteTokens} cache-write tokens, estimated cost ${usd(t.costUsd)}.`,
      '',
    );

    lines.push('## Failures', '');
    if (r.failures.length === 0) lines.push('None.');
    for (const f of r.failures) {
      lines.push(`- ${f.case} run ${f.run}, ${f.check}: ${cell(f.reason)}`);
    }
    lines.push('');
  }

  lines.push('## Detector signals per case', '');
  for (const c of r.cases) {
    lines.push(
      `### ${c.name}`,
      '',
      `seed ${c.seed}; ${c.snapshot.pullRequests} PRs, ${c.snapshot.reviews} reviews, ${c.snapshot.issues} issues, ${c.snapshot.commits} commits; window ${c.window.from.slice(0, 10)} to ${c.window.to.slice(0, 10)}`,
      '',
    );
    if (c.signals.length === 0) {
      lines.push('No signals.', '');
      continue;
    }
    lines.push('| metric | bucket | detector | severity | observed | score |');
    lines.push('|---|---|---|---|---|---|');
    for (const s of c.signals) lines.push(signalLine(s));
    lines.push('');
  }
  return lines.join('\n');
}

/** Writes `<dir>/<timestamp>/report.json` and `report.md`; returns the directory. */
export function writeReport(dir: string, report: EvalReport): string {
  const out = join(dir, report.date.replace(/:/g, '-'));
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  writeFileSync(join(out, 'report.md'), renderMarkdown(report));
  return out;
}
