import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ProblemException } from '../common/problem.exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ENV, type Env } from '../config/env';
import { parseWindow } from '../signals/buckets';
import {
  RepoParamsSchema,
  SyncBodySchema,
  SyncJobParamsSchema,
  toSyncJobResponse,
  type RepoParams,
  type SyncBody,
  type SyncJobParams,
  type SyncJobResponse,
} from './dto';
import { SyncService } from './sync.service';

@ApiTags('sync')
@Controller()
export class SyncController {
  constructor(
    private readonly sync: SyncService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('repos/:owner/:repo/sync')
  @ApiOperation({
    summary: 'Start a background sync for a window, or return the running one',
  })
  @ApiParam({ name: 'owner', example: 'anomalyco' })
  @ApiParam({ name: 'repo', example: 'opencode' })
  @ApiBody({
    required: false,
    schema: {
      type: 'object',
      properties: {
        from: { type: 'string', format: 'date', example: '2026-09-07' },
        to: { type: 'string', format: 'date', example: '2026-10-26' },
      },
    },
  })
  @ApiResponse({ status: 202, description: 'Job created; see Location' })
  @ApiResponse({
    status: 200,
    description: 'A job is already queued or running',
  })
  @ApiResponse({ status: 400, description: 'Invalid owner, repo or window' })
  @ApiResponse({ status: 404, description: 'GitHub has no such repository' })
  @ApiResponse({
    status: 503,
    description: 'GitHub token missing or GitHub unavailable',
  })
  async start(
    @Param(new ZodValidationPipe(RepoParamsSchema)) params: RepoParams,
    @Body(new ZodValidationPipe(SyncBodySchema)) body: SyncBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SyncJobResponse> {
    const window = parseWindow(body, new Date(), this.env.SYNC_MAX_WEEKS);
    const { job, created } = await this.sync.startSync(
      params.owner,
      params.repo,
      window,
    );
    if (created) {
      res.status(202).setHeader('Location', `/api/v1/sync-jobs/${job.id}`);
    } else {
      res.status(200);
    }
    return toSyncJobResponse(job);
  }

  @Get('sync-jobs/:id')
  @ApiOperation({ summary: 'Sync job status and progress counters' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'The job' })
  @ApiResponse({ status: 400, description: 'id is not a UUID' })
  @ApiResponse({ status: 404, description: 'No such job' })
  async get(
    @Param(new ZodValidationPipe(SyncJobParamsSchema)) params: SyncJobParams,
  ): Promise<SyncJobResponse> {
    const job = await this.sync.getJob(params.id);
    if (!job) {
      throw new ProblemException({
        status: 404,
        type: 'not-found',
        title: 'Not Found',
        detail: `No sync job ${params.id}`,
      });
    }
    return toSyncJobResponse(job);
  }
}
