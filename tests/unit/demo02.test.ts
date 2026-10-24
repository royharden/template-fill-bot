import { describe, expect, it } from 'vitest';
import { deriveView } from '../../supabase/functions/_shared/fillkit/index.ts';
import { extractScenario, loadJson } from './m3Helpers.ts';
import type { DemoFixture } from './m3Helpers.ts';
import { assertFixturePointers, traceDemo } from './demoTrace.ts';

const fixture = loadJson<DemoFixture>('demo-02.json');

describe('demo-02: labelled tenancy messages', () => {
  it('traces ambiguous date, rent conflict, utilities completion and optional confirmation to a draft', async () => {
    assertFixturePointers(fixture);
    const state = await traceDemo(fixture);
    const view = deriveView(state);
    expect(view.fields.start_date.value).toBe('2027-04-03');
    expect(view.fields.end_date.value).toBe('2028-04-02');
    expect(view.fields.utilities.value).toEqual(['electricity', 'gas', 'internet']);
  });

  it('does not let the model choose a numeric date reading and preserves the explicit repeated-deposit pointer', async () => {
    const state = await extractScenario(fixture);
    const view = deriveView(state);
    expect(view.fields.start_date.state).toBe('ambiguous');
    expect(view.fields.start_date.value).toBeUndefined();
    expect(view.fields.start_date.candidates.map((c) => c.value)).toEqual(['2027-04-03', '2027-03-04']);
    expect(view.fields.end_date.reasons).toEqual(['pending_dependency']);
    expect(view.fields.deposit.pointer).toBe('msg:m2:76-84');
    expect(view.fields.deposit.value).toBe(120000);
  });
});
