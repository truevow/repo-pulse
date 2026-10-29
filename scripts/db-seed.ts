import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadSnapshot } from '../src/snapshot/snapshot.service';
import type { Snapshot } from '../src/snapshot/snapshot.types';

const SEED_DIR = join(__dirname, '..', 'seed');

async function main(): Promise<void> {
  let files: string[] = [];
  try {
    files = readdirSync(SEED_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (files.length === 0) {
    console.log(
      'No snapshots found in seed/. Add a *.json snapshot (see npm run snapshot:export) and re-run.',
    );
    return;
  }
  const prisma = new PrismaClient();
  try {
    for (const file of files) {
      let snapshot: Snapshot;
      try {
        snapshot = JSON.parse(
          readFileSync(join(SEED_DIR, file), 'utf8'),
        ) as Snapshot;
        await loadSnapshot(prisma, snapshot);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${file}: ${msg}`, { cause: err });
      }
      const { owner, name } = snapshot.repository;
      console.log(
        `${owner}/${name}: ${snapshot.pullRequests.length} PRs, ` +
          `${snapshot.pullRequests.reduce((n, p) => n + p.reviews.length, 0)} reviews, ` +
          `${snapshot.issues.length} issues, ${snapshot.commits.length} commits`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error('Seeding failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
