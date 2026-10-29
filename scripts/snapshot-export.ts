import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { exportSnapshot } from '../src/snapshot/snapshot.service';

async function main(): Promise<void> {
  const [slug, out] = process.argv.slice(2);
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(slug ?? '');
  if (!match || !out) {
    console.error(
      'Usage: npm run snapshot:export -- <owner>/<repo> <out.json>',
    );
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const snapshot = await exportSnapshot(prisma, match[1], match[2]);
    const path = resolve(out);
    writeFileSync(path, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(
      `Wrote ${path}: ${snapshot.pullRequests.length} PRs, ` +
        `${snapshot.pullRequests.reduce((n, p) => n + p.reviews.length, 0)} reviews, ` +
        `${snapshot.issues.length} issues, ${snapshot.commits.length} commits`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('Export failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
