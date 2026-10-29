import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RepoParamsSchema, type RepoParams } from '../ingestion/dto';
import { InsightsQuerySchema } from '../signals/dto';
import { NarrativeService } from './narrative.service';
import type { NarrativeQuery, NarrativeResponse } from './narrative.types';

export const NarrativeQuerySchema = InsightsQuerySchema.extend({
  refresh: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

/** The only throttled controller: each uncached request spends model tokens. */
@ApiTags('narrative')
@Controller()
@UseGuards(ThrottlerGuard)
export class NarrativeController {
  constructor(private readonly narratives: NarrativeService) {}

  @Get('repos/:owner/:repo/narrative')
  @ApiOperation({
    summary:
      'Claude-written narrative and grounded, calibrated hypotheses over the insights',
  })
  @ApiParam({ name: 'owner', example: 'anomalyco' })
  @ApiParam({ name: 'repo', example: 'opencode' })
  @ApiQuery({
    name: 'from',
    required: false,
    schema: { type: 'string', format: 'date', example: '2026-09-07' },
  })
  @ApiQuery({
    name: 'to',
    required: false,
    schema: { type: 'string', format: 'date', example: '2026-10-26' },
  })
  @ApiQuery({ name: 'bucket', required: false, enum: ['week', 'day'] })
  @ApiQuery({ name: 'includeBots', required: false, enum: ['true', 'false'] })
  @ApiQuery({
    name: 'refresh',
    required: false,
    enum: ['true', 'false'],
    description: 'Bypass the narrative cache',
  })
  @ApiOkResponse({
    description:
      'Headline, narrative, hypotheses with evidence and calibrated confidence, grounding report and meta (`cached` says whether it was stored)',
  })
  @ApiResponse({ status: 404, description: 'repo-not-synced' })
  @ApiResponse({ status: 409, description: 'no-signal-data' })
  @ApiResponse({ status: 429, description: 'rate-limited' })
  @ApiResponse({ status: 502, description: 'synthesis-failed' })
  @ApiResponse({
    status: 503,
    description: 'llm-not-configured or llm-unavailable (with Retry-After)',
  })
  get(
    @Param(new ZodValidationPipe(RepoParamsSchema)) params: RepoParams,
    @Query(new ZodValidationPipe(NarrativeQuerySchema)) query: NarrativeQuery,
    @Req() req: Request & { id?: string },
  ): Promise<NarrativeResponse> {
    return this.narratives.getNarrative(
      params.owner,
      params.repo,
      query,
      req.id,
    );
  }
}
