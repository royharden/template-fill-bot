import { useState } from 'react';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { LIBRARY_CONTENT, LIBRARY_LOCK, createMockExtractor, deriveView, gateBundle, runExtraction } from '../core/index.ts';
import type { Bundle, GateResult } from '../core/index.ts';
import { SMUGGLED_ADDRESS } from './fixtures.ts';

/** Only mutates a detached, locally generated sample. Approved bytes are never modified. */
export function tamperDocxSample(bytes: Uint8Array): Uint8Array {
  const parts = unzipSync(bytes.slice());
  const xml = parts['word/document.xml'];
  if (!xml) throw new Error('document_part_missing');
  const text = strFromU8(xml);
  const changed = text.replace(/(<w:t(?:\s[^>]*)?>)([^<]+)/, (_whole, open: string, content: string) => `${open}${content} TAMPERED`);
  if (changed === text) throw new Error('sample_text_missing');
  parts['word/document.xml'] = strToU8(changed);
  return zipSync(parts, { level: 0, mtime: new Date(1980, 0, 1) });
}

export function AdversarialDemo({ bundle, busy }: { readonly bundle: Bundle | null; readonly busy: boolean }) {
  const [addressResult, setAddressResult] = useState<string | null>(null);
  const [docxResult, setDocxResult] = useState<GateResult | null>(null);
  const [running, setRunning] = useState(false);
  async function inspectAddress(): Promise<void> {
    setRunning(true);
    try {
      const result = await runExtraction(SMUGGLED_ADDRESS.messages, createMockExtractor(SMUGGLED_ADDRESS, SMUGGLED_ADDRESS.scenario_id));
      if (!result.ok) { setAddressResult(`Blocked: ${result.error.code}`); return; }
      const address = deriveView(result.state).fields.address;
      setAddressResult(`Address: ${address.state} · ${address.reasons.join(', ')}. A model’s clause sentence cannot supply the address value.`);
    } catch { setAddressResult('Sample could not be inspected. No agreement was generated.'); }
    finally { setRunning(false); }
  }
  function inspectDocx(): void {
    if (!bundle) return;
    try { setDocxResult(gateBundle({ content: LIBRARY_CONTENT, lock: LIBRARY_LOCK, provenanceBytes: bundle.files['provenance.json'], markdownBytes: bundle.files['agreement.md'], docxBytes: tamperDocxSample(bundle.files['agreement.docx']) })); }
    catch { setDocxResult({ ok: false, failures: [{ code: 'sample_failed', detail: 'Could not prepare the detached DOCX sample.' }] }); }
  }
  return <details className="card adversarial"><summary>Safety lab · inspect two adversarial samples</summary><p className="muted">Local mock examples. These never alter your matter or approved files.</p><div className="lab-grid"><article><h3>A clause hidden in an address</h3><p className="small">Replay the bundled smuggled-address fixture through grounding and validation.</p><button className="secondary" disabled={busy || running} onClick={() => { void inspectAddress(); }}>Inspect smuggled address</button>{addressResult && <p role="status" className="small">{addressResult}</p>}</article><article><h3>A changed DOCX paragraph</h3><p className="small">Change text in a copy of word/document.xml and pass the final bytes to the independent gate.</p><button className="secondary" disabled={busy || !bundle} onClick={inspectDocx}>Inspect tampered DOCX</button>{!bundle && <p className="small muted">Available after the library is locked and a bundle is generated.</p>}{docxResult && <div role="status"><p>{docxResult.ok ? 'Unexpected gate pass — investigate before approval.' : 'Gate rejected the sample.'}</p><ul>{docxResult.failures.map((failure, index) => <li key={index}><code>{failure.code}</code>{failure.paragraph_index === undefined ? '' : ` · paragraph ${failure.paragraph_index + 1}`}<p className="small">{failure.detail}</p></li>)}</ul></div>}</article></div></details>;
}
