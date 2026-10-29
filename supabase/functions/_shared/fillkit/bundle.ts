import { LIBRARY_LOCK } from '../content/library.lock.ts';
import type { LibraryContent, LibraryLock } from '../content/types.ts';
import { writeDocx } from '../docx/writeDocx.ts';
import { canonicalJson } from './canonicalJson.ts';
import { sha256Hex, utf8Encode } from './hash.ts';
import { LIBRARY_CONTENT } from './library.ts';
import type { MatterState } from './matter.ts';
import { buildDraft } from './pipeline.ts';
import { gateBundle } from './gate/gate.ts';
import type { GateResult } from './gate/gate.ts';

export const APP_VERSION = '0.1.0';
export const AGREEMENT_FILES = ['agreement.md','agreement.docx','provenance.json'] as const;
export type AgreementFilename = (typeof AGREEMENT_FILES)[number];
export type BundleFilename = AgreementFilename | 'bundle.json';
export interface BundleManifest {
  readonly matter_id: string | null;
  readonly revision: number;
  readonly files: Readonly<Record<AgreementFilename, string>>;
  readonly library_hash: string;
  readonly jurisdiction_hash: string;
  readonly app_version: string;
}
export interface Bundle {
  readonly manifest: BundleManifest;
  readonly digest: string;
  /** Retained bytes are mutable typed arrays; every approval/download re-hashes and re-gates them. */
  readonly files: Readonly<Record<BundleFilename, Uint8Array>>;
  readonly gate: GateResult;
}
export interface BundleOptions { readonly matterId?: string | null; readonly content?: LibraryContent; readonly lock?: LibraryLock; readonly appVersion?: string }
export type BundleResult = { readonly ok: true; readonly bundle: Bundle } | { readonly ok: false; readonly reasons: readonly string[]; readonly gate?: GateResult };

export function bundleDigest(manifest: BundleManifest): string { return sha256Hex(canonicalJson(manifest)); }
export function verifyBundle(bundle: Bundle, opts: BundleOptions = {}): GateResult {
  const failures = [];
  try {
    const m = bundle.manifest;
    if (Object.keys(m).sort().join(',') !== 'app_version,files,jurisdiction_hash,library_hash,matter_id,revision' || !Number.isSafeInteger(m.revision) || m.revision < 1 || !/^[a-f0-9]{64}$/.test(m.library_hash) || !/^[a-f0-9]{64}$/.test(m.jurisdiction_hash) || !m.app_version) throw new Error('manifest');
    if (Object.keys(m.files).sort().join(',') !== [...AGREEMENT_FILES].sort().join(',') || Object.keys(bundle.files).sort().join(',') !== [...AGREEMENT_FILES,'bundle.json'].sort().join(',')) throw new Error('files');
    const json = canonicalJson(m);
    if (sha256Hex(json) !== bundle.digest || sha256Hex(bundle.files['bundle.json']) !== sha256Hex(json)) throw new Error('digest');
    for (const name of AGREEMENT_FILES) if (sha256Hex(bundle.files[name]) !== m.files[name]) throw new Error('hash');
    if ((opts.matterId !== undefined && opts.matterId !== m.matter_id) || (opts.appVersion !== undefined && opts.appVersion !== m.app_version)) throw new Error('binding');
    const p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bundle.files['provenance.json'])) as { matter_id: unknown; revision: unknown; library_hash: unknown; jurisdiction_hash: unknown };
    if (p.matter_id !== m.matter_id || p.revision !== m.revision || p.library_hash !== m.library_hash || p.jurisdiction_hash !== m.jurisdiction_hash) throw new Error('provenance_binding');
  } catch { failures.push({ code: 'bundle_integrity', detail: 'Manifest or file bytes no longer match the digest' }); }
  if (failures.length) return { ok: false, failures };
  return gateBundle({ content: opts.content ?? LIBRARY_CONTENT, lock: opts.lock ?? LIBRARY_LOCK, provenanceBytes: bundle.files['provenance.json'], markdownBytes: bundle.files['agreement.md'], docxBytes: bundle.files['agreement.docx'] });
}
/** No model call: all bytes come from canonical persisted state and the pinned library. */
export function buildBundle(state: MatterState, opts: BundleOptions = {}): BundleResult {
  const draft = buildDraft(state, opts);
  if (!draft.ok) return draft;
  try {
    const agreement = { 'agreement.md': utf8Encode(draft.markdown), 'agreement.docx': writeDocx(draft.paragraphs), 'provenance.json': draft.provenanceBytes };
    const manifest: BundleManifest = { matter_id: opts.matterId ?? null, revision: state.revision, files: { 'agreement.md': sha256Hex(agreement['agreement.md']), 'agreement.docx': sha256Hex(agreement['agreement.docx']), 'provenance.json': sha256Hex(agreement['provenance.json']) }, library_hash: draft.provenance.library_hash, jurisdiction_hash: draft.provenance.jurisdiction_hash, app_version: opts.appVersion ?? APP_VERSION };
    const gate = gateBundle({ content: opts.content ?? LIBRARY_CONTENT, lock: opts.lock ?? LIBRARY_LOCK, provenanceBytes: agreement['provenance.json'], markdownBytes: agreement['agreement.md'], docxBytes: agreement['agreement.docx'] });
    if (!gate.ok) return { ok: false, reasons: gate.failures.map((f) => f.code), gate };
    return { ok: true, bundle: { manifest, digest: bundleDigest(manifest), files: { ...agreement, 'bundle.json': utf8Encode(canonicalJson(manifest)) }, gate } };
  } catch { return { ok: false, reasons: ['bundle_generation_failed'] }; }
}
