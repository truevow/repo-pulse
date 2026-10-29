import { Prisma } from '@prisma/client';
import { repositoryResult } from '../../test/fixtures/github/small-repo';
import { SyncService } from './sync.service';

const WINDOW = {
  from: new Date('2026-09-07T00:00:00Z'),
  to: new Date('2026-10-26T00:00:00Z'),
};

const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`githubId`)',
    { code: 'P2002', clientVersion: Prisma.prismaVersion.client },
  );

/** A prisma double whose first `failures` transactions throw the given errors. */
function setup(failures: Error[]) {
  const job = { id: 'job-1', repositoryId: 7 };
  const tx = {
    repository: {
      upsert: jest.fn(() => Promise.resolve({ id: 7, coveredFrom: null })),
    },
    syncJob: {
      findFirst: jest.fn(() => Promise.resolve(null)),
      create: jest.fn(() => Promise.resolve(job)),
    },
  };
  const queue = [...failures];
  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => {
      const next = queue.shift();
      if (next) throw next;
      return fn(tx);
    }),
  };
  const github = { query: jest.fn(() => Promise.resolve(repositoryResult())) };
  const runner = { enqueue: jest.fn() };
  const service = new SyncService(
    prisma as never,
    github as never,
    runner as never,
  );
  return { service, prisma, tx, runner, job };
}

describe('SyncService.startSync', () => {
  it('retries once when a concurrent first request wins the githubId insert', async () => {
    const { service, prisma, runner, job } = setup([uniqueViolation()]);
    const out = await service.startSync('acme', 'widgets', WINDOW);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ job, created: true });
    expect(runner.enqueue).toHaveBeenCalledWith('job-1', 7);
  });

  it('gives up after one retry, and never retries other errors', async () => {
    const twice = setup([uniqueViolation(), uniqueViolation()]);
    await expect(
      twice.service.startSync('acme', 'widgets', WINDOW),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(twice.prisma.$transaction).toHaveBeenCalledTimes(2);

    const other = setup([new Error('connection reset')]);
    await expect(
      other.service.startSync('acme', 'widgets', WINDOW),
    ).rejects.toThrow('connection reset');
    expect(other.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(other.runner.enqueue).not.toHaveBeenCalled();
  });
});
