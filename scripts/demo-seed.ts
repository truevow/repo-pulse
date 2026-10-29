import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { CASES, START, WEEKS } from '../eval/cases';
import { buildSnapshot } from '../eval/fixtures/synthetic';
import { loadSnapshot } from '../src/snapshot/snapshot.service';

const DAY_MS = 86_400_000;

/**
 * Loads one synthetic eval fixture (default: latency_spike) into the database
 * in DATABASE_URL, so the API can be tried without a GitHub token.
 * Usage: npm run demo:seed [-- <case>]
 *
 * Fixtures reuse synthetic GitHub ids (PR_<n>, I_<n>) across cases, so the
 * repositories owned by `evalco` (previously loaded cases) are deleted first:
 * one case at a time. If another repository already holds one of those ids
 * (other synthetic test data), the load would re-point its rows, so the
 * script refuses instead.
 */
async function main(): Promise<void> {
  const name = process.argv[2] ?? 'latency_spike';
  const found = CASES.find((c) => c.name === name);
  if (!found) {
    console.error(
      `Unknown case "${name}"; one of: ${CASES.map((c) => c.name).join(', ')}`,
    );
    process.exit(2);
  }
  const snapshot = buildSnapshot(found.spec);
  const prisma = new PrismaClient();
  try {
    const owner = snapshot.repository.owner;
    await prisma.repository.deleteMany({ where: { owner } });
    const notOurs = { repository: { owner: { not: owner } } };
    const clash =
      (await prisma.pullRequest.findFirst({
        where: {
          githubId: { in: snapshot.pullRequests.map((p) => p.githubId) },
          ...notOurs,
        },
        select: { repository: { select: { owner: true, name: true } } },
      })) ??
      (await prisma.issue.findFirst({
        where: {
          githubId: { in: snapshot.issues.map((i) => i.githubId) },
          ...notOurs,
        },
        select: { repository: { select: { owner: true, name: true } } },
      }));
    if (clash) {
      const { owner: o, name: n } = clash.repository;
      throw new Error(
        `${o}/${n} already uses this fixture's synthetic GitHub ids; use an empty database`,
      );
    }
    await loadSnapshot(prisma, snapshot);
  } finally {
    await prisma.$disconnect();
  }
  const { owner, name: repo } = snapshot.repository;
  const to = new Date(Date.parse(START) + WEEKS * 7 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  console.log(
    `${owner}/${repo} (${name}): ${snapshot.pullRequests.length} PRs, ` +
      `${snapshot.issues.length} issues, ${snapshot.commits.length} commits; ` +
      `query it with ?from=${START}&to=${to}`,
  );
}

main().catch((err: unknown) => {
  console.error('Demo seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
