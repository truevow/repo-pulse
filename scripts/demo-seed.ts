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
 * Fixtures reuse GitHub ids (PR_1, I_1, ...) across cases, so the previously
 * loaded fixture repositories (owner `evalco`) are deleted first: one case at
 * a time. Real repositories are never touched.
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
    await prisma.repository.deleteMany({
      where: { owner: snapshot.repository.owner },
    });
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
