import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { SyncJobExecutor } from './sync-job.executor';

/**
 * In-process job queue: one promise chain per repository so jobs for a repo
 * run one at a time. The SyncJob table is the seam where a real queue would go.
 */
@Injectable()
export class SyncRunner implements OnApplicationBootstrap {
  private readonly chains = new Map<number, Promise<void>>();
  private pending = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: SyncJobExecutor,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SyncRunner.name);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.recoverInterruptedJobs();
  }

  /** Jobs left queued/running by a previous process can never finish; fail them. */
  async recoverInterruptedJobs(): Promise<void> {
    const { count } = await this.prisma.syncJob.updateMany({
      where: { status: { in: ['queued', 'running'] } },
      data: { status: 'failed', error: 'interrupted', finishedAt: new Date() },
    });
    if (count > 0) {
      this.logger.warn({ count }, 'marked interrupted sync jobs as failed');
    }
  }

  /** Schedules the job; never runs it inline and never rejects. */
  enqueue(jobId: string): void {
    this.pending++;
    void this.schedule(jobId)
      .catch((err: unknown) =>
        this.logger.error({ err, jobId }, 'sync job crashed outside executor'),
      )
      .finally(() => this.settle());
  }

  /** Resolves once no job is queued or running. */
  whenIdle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private async schedule(jobId: string): Promise<void> {
    const { repositoryId } = await this.prisma.syncJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { repositoryId: true },
    });
    const previous = this.chains.get(repositoryId) ?? Promise.resolve();
    const current = previous.then(() => this.executor.run(jobId));
    // The chain itself must never reject, or later jobs would be skipped.
    const tail = current.catch(() => undefined);
    this.chains.set(repositoryId, tail);
    try {
      await current;
    } finally {
      if (this.chains.get(repositoryId) === tail) {
        this.chains.delete(repositoryId);
      }
    }
  }

  private settle(): void {
    this.pending--;
    if (this.pending > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
