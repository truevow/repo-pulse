import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RepoParamsSchema, type RepoParams } from '../ingestion/dto';
import { InsightsQuerySchema, type InsightsQuery } from './dto';
import type { InsightsResponse } from './insights.types';
import { InsightsService } from './insights.service';

@ApiTags('insights')
@Controller()
export class InsightsController {
  constructor(private readonly insights: InsightsService) {}

  @Get('repos/:owner/:repo/insights')
  @ApiOperation({
    summary:
      'Bucketed metrics, leaderboards and detector signals for a synced repository',
  })
  @ApiParam({ name: 'owner', example: 'anomalyco' })
  @ApiParam({ name: 'repo', example: 'opencode' })
  @ApiQuery({
    name: 'from',
    required: false,
    schema: { type: 'string', format: 'date', example: '2026-09-07' },
    description: 'Inclusive UTC start; defaults to 8 weeks before `to`',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    schema: { type: 'string', format: 'date', example: '2026-10-26' },
    description: 'Exclusive UTC end; defaults to the current ISO week start',
  })
  @ApiQuery({ name: 'bucket', required: false, enum: ['week', 'day'] })
  @ApiQuery({ name: 'includeBots', required: false, enum: ['true', 'false'] })
  @ApiOkResponse({
    description:
      'Coverage, availability, per-bucket metrics, leaderboards, signals with examples and detector parameters',
  })
  @ApiResponse({ status: 400, description: 'Invalid owner, repo or window' })
  @ApiResponse({
    status: 404,
    description: 'Repository has not been synced (repo-not-synced)',
  })
  get(
    @Param(new ZodValidationPipe(RepoParamsSchema)) params: RepoParams,
    @Query(new ZodValidationPipe(InsightsQuerySchema)) query: InsightsQuery,
  ): Promise<InsightsResponse> {
    return this.insights.getInsights(params.owner, params.repo, query);
  }
}
