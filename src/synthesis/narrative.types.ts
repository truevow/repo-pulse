import type { InsightsQuery } from '../signals/dto';
import type { InsightsResponse } from '../signals/insights.types';
import type { CalibratedHypothesis } from './calibration';
import type { GroundingResult } from './grounding';
import type { ModelUsage } from './model-runner';

export interface NarrativeUsage extends ModelUsage {
  /** Estimated from list prices; see `costUsd` in narrative.service.ts. */
  costUsd: number;
}

export interface NarrativeResponse {
  repository: InsightsResponse['repository'];
  window: InsightsResponse['window'];
  bucket: InsightsResponse['bucket'];
  cached: boolean;
  generatedAt: string;
  headline: string;
  narrative: string;
  hypotheses: CalibratedHypothesis[];
  data_caveats: string[];
  grounding: {
    status: GroundingResult['status'];
    rejected: GroundingResult['rejected'];
    unverifiedNumbers: number[];
    droppedHypotheses: number;
  };
  meta: {
    model: string;
    promptVersion: string;
    usage: NarrativeUsage;
    toolCalls: number;
    turns: number;
    latencyMs: number;
  };
}

export type NarrativeQuery = InsightsQuery & { refresh: boolean };
