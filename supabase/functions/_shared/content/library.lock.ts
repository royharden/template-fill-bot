// GENERATED FILE: written only by `npm run lock` (scripts/lock.ts). Do not edit by hand.
//
// This committed version is the UNLOCKED sentinel (PLAN K17): Dirty Mode deferred running the lock script, so
// fillkit/library.ts treats this as a lock failure and every render / gate run fails closed with
// reasons ['library_unlocked']. Activation step DV-LOCK: run `npm run lock`, review the printed diff, commit.
import type { LibraryLock } from './types.ts';

export const LIBRARY_LOCK: LibraryLock = {
  status: 'UNLOCKED',
  note: 'run npm run lock (DV-LOCK)',
};
