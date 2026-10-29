import type { ReactNode } from 'react';
import type { IntakeMessageInput, MatterState } from '../core/index.ts';
import type { Store } from '../store/Store.ts';

/** M6b supplies actual auth UI, a signed-in RLS Store, and the persist-intake/edge extraction workflow.
 * extract must save raw messages BEFORE calling extract-fields, then persist the returned canonical state.
 * Never fabricate a session from configuration alone. Default App props provide no live capability. */
export interface LiveControls {
  readonly session: { readonly userId: string } | null;
  readonly store: Store | null;
  readonly providerLabel: string;
  readonly authContent?: ReactNode;
  readonly extract?: (messages: readonly IntakeMessageInput[], method: 'llm' | 'jev', matterId: string | null) => Promise<{ readonly matterId: string; readonly state: MatterState }>;
}
