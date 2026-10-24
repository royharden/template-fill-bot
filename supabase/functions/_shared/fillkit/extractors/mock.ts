// Mock extractor: fixture replay keyed by scenario id + replayed method (PLAN section 4.5). No model, no network.
// The replayed output is returned as an untrusted deep copy, so it passes through exactly the same
// parseExtractorOutput (zod + unknown-key stripping) and grounding path as a live model's output; values are
// recorded with method token `mock`.
import type { AllCandidates } from '../candidates/index.ts';
import type { FieldSpec } from '../fields.ts';
import type { IntakeLike } from '../normalize.ts';
import type { Extractor } from './types.ts';

/** The part of a fixture file (fixtures/*.json) the mock reads. Other keys (expectations) are ignored. */
export interface MockFixture {
  readonly scenario_id: string;
  /** Raw extractor outputs keyed by the method they imitate, e.g. `{ "llm": {fields, requests} }`. */
  readonly mock_outputs: Readonly<Record<string, unknown>>;
}

export class MockFixtureError extends Error {
  readonly code: 'scenario_not_found' | 'method_not_found';

  constructor(code: 'scenario_not_found' | 'method_not_found') {
    super(code);
    this.name = 'MockFixtureError';
    this.code = code;
  }
}

function deepCopy(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Replay `fixture.mock_outputs[replays]` for `scenarioId`. Throws MockFixtureError when absent. */
export function createMockExtractor(
  fixtures: MockFixture | readonly MockFixture[],
  scenarioId: string,
  replays = 'llm',
): Extractor {
  const list: readonly MockFixture[] = Array.isArray(fixtures) ? fixtures : [fixtures as MockFixture];
  return {
    method: 'mock',
    extract(_intake: IntakeLike, _fieldSpecs: readonly FieldSpec[], _candidates: AllCandidates): Promise<unknown> {
      const fixture = list.find((f) => f.scenario_id === scenarioId);
      if (fixture === undefined) return Promise.reject(new MockFixtureError('scenario_not_found'));
      if (!Object.prototype.hasOwnProperty.call(fixture.mock_outputs, replays)) {
        return Promise.reject(new MockFixtureError('method_not_found'));
      }
      return Promise.resolve(deepCopy(fixture.mock_outputs[replays]));
    },
  };
}
