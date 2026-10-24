import { canDownload } from './reviewModel.ts';
import type { Bundle, BundleApproval, BundleFilename, BundleResult, MatterState } from '../core/index.ts';

export function GateStatus({ result }: { readonly result: BundleResult | null }) {
  if (!result) return <p className="small muted">The gate checks Markdown and DOCX independently when you generate a bundle.</p>;
  if (result.ok) return <div className="success-note" role="status">Gate passed · Markdown + DOCX final bytes match the locked reconstruction.</div>;
  return <div className="blocked-note" role="status"><strong>Bundle blocked</strong><ul>{result.gate ? result.gate.failures.map((failure, i) => <li key={i}><code>{failure.code}</code>{failure.paragraph_index === undefined ? '' : ` · paragraph ${failure.paragraph_index + 1}`} — {failure.detail}</li>) : result.reasons.map((reason) => <li key={reason}><code>{reason}</code></li>)}</ul>{result.reasons.includes('library_unlocked') && <p>Activation required: run <code>npm run lock</code>, review and commit the library lock, then regenerate. The app never creates its own lock.</p>}</div>;
}

export function ApprovalBar({ state, matterId, bundle, approval, result, busy, dirty, approver, onApprover, onGenerate, onApprove, onDownload }: {
  readonly state: MatterState | null; readonly matterId: string | null; readonly bundle: Bundle | null; readonly approval: BundleApproval | null; readonly result: BundleResult | null; readonly busy: boolean; readonly dirty: boolean; readonly approver: string;
  readonly onApprover: (value: string) => void; readonly onGenerate: () => void; readonly onApprove: () => void; readonly onDownload: (filename: BundleFilename) => void;
}) {
  const approved = canDownload(bundle, approval, matterId, state, dirty);
  const current = !dirty && state !== null && matterId !== null && bundle !== null && bundle.gate.ok && bundle.manifest.matter_id === matterId && bundle.manifest.revision === state.revision;
  return <section className="card approval-card" id="downloads"><div className="section-heading"><div><div className="eyebrow">04 · Approve & export</div><h2>A decision tied to exact files</h2></div><span className={`status ${approved ? 'status-valid' : 'status-missing'}`}>{approved ? 'Approved' : 'Awaiting approval'}</span></div><p className="muted">Generate, inspect, then approve this revision’s digest. Any change clears this review and requires a new approval.</p><GateStatus result={result} />
    <div className="approval-actions"><button className="primary" disabled={busy || !state || dirty} onClick={onGenerate}>Generate & check bundle</button><label>Reviewer name<input maxLength={120} value={approver} onChange={(e) => onApprover(e.target.value)} disabled={busy} placeholder="Your name" /></label><button className="secondary" disabled={busy || !current || !approver.trim() || approved} onClick={onApprove}>Approve this exact bundle</button></div>
    {bundle && <div className="digest"><span className="eyebrow">Revision {bundle.manifest.revision} · SHA-256 bundle digest</span><code>{bundle.digest}</code></div>}
    {approved && approval && <p className="small success-text">Approved by {approval.approver} · {approval.approved_at}</p>}
    <div className="download-row">{(['agreement.md', 'agreement.docx', 'provenance.json', 'bundle.json'] as const).map((filename) => <button className="download-button" key={filename} disabled={busy || !approved} onClick={() => onDownload(filename)}><span aria-hidden="true">↓</span> {filename}</button>)}</div><p className="small muted">Each download re-gates the bytes and regenerates from the persisted state of the current revision.</p>
  </section>;
}
