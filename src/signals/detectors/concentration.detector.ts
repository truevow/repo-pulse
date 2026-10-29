import {
  DETECTOR_PARAMETERS,
  type ConcentrationRow,
  type Signal,
} from '../signal.types';
import { signalId } from './robust-stats';

const METRIC = 'review_concentration_top1';

/** Flags complete buckets where one reviewer submitted most of a meaningful number of reviews. */
export function detectReviewConcentration(
  rows: ConcentrationRow[],
  p: typeof DETECTOR_PARAMETERS = DETECTOR_PARAMETERS,
): Signal[] {
  return rows.flatMap((row): Signal[] => {
    const { bucket, reviews, top1Share: share, topLogin } = row;
    if (
      row.partial ||
      share === null ||
      topLogin === null ||
      reviews < p.concentrationMinReviews ||
      share < p.concentrationTop1Share
    ) {
      return [];
    }
    return [
      {
        id: signalId('review_concentration', METRIC, bucket),
        detector: 'review_concentration',
        metric: METRIC,
        bucket,
        observed: share,
        baseline: null,
        score: share,
        direction: 'up',
        severity: share >= p.concentrationHighShare ? 'high' : 'moderate',
        description: `${topLogin} submitted ${Math.round(share * 100)}% of ${reviews} reviews in ${bucket}`,
        entity: topLogin,
        examples: [],
      },
    ];
  });
}
