import { Module } from '@nestjs/common';
import { GithubModule } from '../github/github.module';
import { SyncController } from './sync.controller';
import { SyncJobExecutor } from './sync-job.executor';
import { SyncRunner } from './sync-runner';
import { SyncService } from './sync.service';

@Module({
  imports: [GithubModule],
  controllers: [SyncController],
  providers: [SyncService, SyncRunner, SyncJobExecutor],
  exports: [SyncService, SyncRunner],
})
export class IngestionModule {}
