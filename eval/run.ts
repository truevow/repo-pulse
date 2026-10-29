// Must come first: points DATABASE_URL at the test database before Nest loads.
import './env';

import { resolve } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ProblemException } from '../src/common/problem.exception';
import { ENV, type Env } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';
import { InsightsService } from '../src/signals/insights.service';
import type { Signal } from '../src/signals/signal.types';
import { loadSnapshot } from '../src/snapshot/snapshot.service';
import { costUsd } from '../src/synthesis/cost';
import { NarrativeService } from '../src/synthesis/narrative.service';
import type { NarrativeResponse } from '../src/synthesis/narrative.types';
import { PROMPT_VERSION } from '../src/synthesis/prompts/system.v1';
import { createTestApp, resetDatabase } from '../test/setup/db';
import { CASES, START, WEEKS, type EvalCase } from './cases';
import { failedRun, gradeRun, topConfidence } from './checks';
import { buildSnapshot } from './fixtures/synthetic';
import {
  buildReport,
  writeReport,
  type CaseRecord,
  type EvalReport,
  type RunRecord,
  type SignalSummary,
} from './report';

const REPORTS_DIR = resolve(__dirname, 'reports');
const DAY_MS = 86_400_000;
const PLANTED_MUST_NAME = ['latency_spike', 'concentration'];
const MIN_GROUNDING_RATE = 0.9;

interface CaseResult {
  record: CaseRecord;
  /** Aligned with record.runs; null for a failed run. */
  responses: Array<NarrativeResponse | null>;
}

interface Args {
  runs: number;
  caseFilter: string | null;
  dry: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { runs: 3, caseFilter: null, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') args.dry = true;
    else if (a === '--runs') args.runs = Number(argv[++i]);
    else if (a === '--case') args.caseFilter = argv[++i] ?? null;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    throw new Error('--runs must be a positive integer');
  }
  if (args.caseFilter && !CASES.some((c) => c.name === args.caseFilter)) {
    throw new Error(
      `Unknown case "${args.caseFilter}"; one of: ${CASES.map((c) => c.name).join(', ')}`,
    );
  }
  return args;
}

const windowOf = () => ({
  from: START,
  to: new Date(Date.parse(`${START}T00:00:00Z`) + WEEKS * 7 * DAY_MS)
    .toISOString()
    .slice(0, 10),
});

const query = (refresh: boolean) => ({
  ...windowOf(),
  bucket: 'week' as const,
  includeBots: false,
  refresh,
});

function summarizeSignal(s: Signal): SignalSummary {
  return {
    id: s.id,
    detector: s.detector,
    metric: s.metric,
    bucket: s.bucket,
    entity: s.entity,
    observed: s.observed,
    baselineMedian: s.baseline?.median ?? null,
    score: s.score,
    severity: s.severity,
  };
}

function describeError(err: unknown): NonNullable<RunRecord['problem']> {
  if (err instanceof ProblemException) {
    return {
      status: err.problem.status,
      type: err.problem.type,
      detail: err.problem.detail ?? err.problem.title,
    };
  }
  return {
    status: null,
    type: err instanceof Error ? err.name : 'unknown',
    detail: err instanceof Error ? err.message : String(err),
  };
}

const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

function successRecord(
  run: number,
  r: NarrativeResponse,
  latencyMs: number,
): RunRecord {
  return {
    run,
    ok: true,
    problem: null,
    latencyMs,
    generationMs: r.meta.latencyMs,
    toolCalls: r.meta.toolCalls,
    turns: r.meta.turns,
    model: r.meta.model,
    usage: { ...r.meta.usage, costUsd: costUsd(r.meta.usage) },
    topConfidence: topConfidence(r),
    headline: r.headline,
    narrative: r.narrative,
    hypotheses: r.hypotheses,
    dataCaveats: r.data_caveats,
    grounding: r.grounding,
    checks: null,
  };
}

function failureRecord(
  run: number,
  err: unknown,
  latencyMs: number,
): RunRecord {
  return {
    run,
    ok: false,
    problem: describeError(err),
    latencyMs,
    generationMs: null,
    toolCalls: 0,
    turns: 0,
    model: null,
    usage: ZERO_USAGE,
    topConfidence: null,
    headline: null,
    narrative: null,
    hypotheses: [],
    dataCaveats: [],
    grounding: null,
    checks: null,
  };
}

async function runCase(
  app: NestExpressApplication,
  c: EvalCase,
  args: Args,
): Promise<CaseResult> {
  const prisma = app.get(PrismaService);
  const snapshot = buildSnapshot(c.spec);
  await resetDatabase(prisma);
  await loadSnapshot(prisma, snapshot);

  const { owner, name } = c.spec;
  const insights = await app
    .get(InsightsService)
    .getInsights(owner, name, query(false));
  const record: CaseRecord = {
    name: c.name,
    expect: c.expect,
    seed: c.spec.seed,
    perturbations: c.spec.perturbations,
    snapshot: {
      pullRequests: snapshot.pullRequests.length,
      reviews: snapshot.pullRequests.reduce((n, p) => n + p.reviews.length, 0),
      issues: snapshot.issues.length,
      commits: snapshot.commits.length,
    },
    window: insights.window,
    signals: insights.signals.map(summarizeSignal),
    runs: [],
  };
  console.log(`[${c.name}] ${insights.signals.length} signal(s)`);

  const responses: Array<NarrativeResponse | null> = [];
  if (args.dry) return { record, responses };

  const narratives = app.get(NarrativeService);
  for (let run = 1; run <= args.runs; run++) {
    const started = Date.now();
    try {
      const r = await narratives.getNarrative(owner, name, query(true));
      record.runs.push(successRecord(run, r, Date.now() - started));
      responses.push(r);
      console.log(
        `[${c.name}] run ${run}: ${r.hypotheses.length} hypothesis(es), top ${topConfidence(r)}, ` +
          `grounding ${r.grounding.status}, ${r.meta.toolCalls} tool call(s), ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s, $${r.meta.usage.costUsd.toFixed(4)}`,
      );
    } catch (err) {
      const rec = failureRecord(run, err, Date.now() - started);
      record.runs.push(rec);
      responses.push(null);
      console.log(`[${c.name}] run ${run}: FAILED ${rec.problem?.type}`);
    }
  }
  return { record, responses };
}

/** Mean top confidence over the control's successful runs; 0 for runs with no hypotheses. */
function controlMean(results: CaseResult[]): number | null {
  const control = results.find((r) => r.record.name === 'control');
  if (!control) return null;
  const ok = control.responses.filter(
    (r): r is NarrativeResponse => r !== null,
  );
  return ok.length === 0
    ? 0
    : ok.reduce((a, r) => a + topConfidence(r), 0) / ok.length;
}

function grade(results: CaseResult[], baseline: number | null): void {
  for (const { record, responses } of results) {
    record.runs.forEach((run, i) => {
      const r = responses[i];
      run.checks = r
        ? gradeRun(r, record.expect, record.signals, baseline)
        : failedRun(
            record.expect,
            `${run.problem?.status ?? '-'} ${run.problem?.type}`,
            baseline,
          );
    });
  }
}

function exitCode(report: EvalReport): number {
  if (report.dry) return 0;
  const grounding = report.totals.passRates.schema_and_grounding;
  if (grounding !== null && grounding < MIN_GROUNDING_RATE) return 1;
  for (const name of PLANTED_MUST_NAME) {
    const s = report.summaries.find((x) => x.name === name);
    if (s && s.passRates.names_planted_metric === 0) return 1;
  }
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dry && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      'ANTHROPIC_API_KEY is not set: add it to .env, or pass --dry to build fixtures and signals only.',
    );
    return 1;
  }
  const cases = CASES.filter(
    (c) => args.caseFilter === null || c.name === args.caseFilter,
  );

  const app = await createTestApp();
  try {
    const env = app.get<Env>(ENV);
    const results: CaseResult[] = [];
    for (const c of cases) results.push(await runCase(app, c, args));
    const baseline = args.dry ? null : controlMean(results);
    if (!args.dry) grade(results, baseline);

    const report = buildReport({
      promptVersion: PROMPT_VERSION,
      model: env.ANTHROPIC_MODEL,
      effort: env.ANTHROPIC_EFFORT,
      runs: args.runs,
      date: new Date(),
      dry: args.dry,
      caseFilter: args.caseFilter,
      controlMeanTopConfidence: baseline,
      cases: results.map((r) => r.record),
    });
    const dir = writeReport(REPORTS_DIR, report);
    console.log(`Report: ${dir}`);
    if (!report.dry) {
      const t = report.totals;
      console.log(
        `Overall: ${Object.entries(t.passRates)
          .map(
            ([k, v]) =>
              `${k} ${v === null ? 'n/a' : `${Math.round(v * 100)}%`}`,
          )
          .join(', ')}; cost $${t.costUsd.toFixed(4)}`,
      );
    }
    return exitCode(report);
  } finally {
    await app.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error('Eval failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  },
);
