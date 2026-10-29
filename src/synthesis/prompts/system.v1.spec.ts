import {
  CONCENTRATION_SIGNAL,
  INSIGHTS_FIXTURE,
} from '../../../test/fixtures/insights.fixture';
import { FactLedger, seedLedgerFromInsights } from '../fact-ledger';
import { SYSTEM_PROMPT } from './system.v1';

describe('SYSTEM_PROMPT key convention', () => {
  it('tells the model signal facts use entity null, which is how the ledger seeds them', () => {
    expect(SYSTEM_PROMPT).toContain(
      'Signal facts (observed, <metric>.observed, <metric>.baseline_median) always use entity = null',
    );
    const ledger = new FactLedger();
    seedLedgerFromInsights(ledger, INSIGHTS_FIXTURE);
    const cell = {
      metric: CONCENTRATION_SIGNAL.metric,
      bucket: CONCENTRATION_SIGNAL.bucket,
    };
    // The concentration signal names bob, but its fact is keyed without him.
    expect(CONCENTRATION_SIGNAL.entity).toBe('bob');
    expect(ledger.lookup({ ...cell, entity: null })?.value).toBe(0.75);
    expect(ledger.lookup({ ...cell, entity: 'bob' })).toBeUndefined();
  });
});
