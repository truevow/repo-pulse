import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { errorLogFields } from '../github/github.errors';
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

  /**
   * Appends the job to its repository's chain synchronously, so jobs for one
   * repo start in enqueue order. Never runs the job inline and never rejects.
   */
  enqueue(jobId: string, repositoryId: number): void {
    this.pending++;
    const previous = this.chains.get(repositoryId) ?? Promise.resolve();
    const current: Promise<void> = previous
      .then(() => this.executor.run(jobId))
      .catch((err: unknown) =>
        this.logger.error(
          { jobId, ...errorLogFields(err) },
          'sync job crashed outside executor',
        ),
      )
      .finally(() => {
        if (this.chains.get(repositoryId) === current) {
          this.chains.delete(repositoryId);
        }
        this.settle();
      });
    this.chains.set(repositoryId, current);
  }

  /** Resolves once no job is queued or running. */
  whenIdle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private settle(): void {
    this.pending--;
    if (this.pending > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
