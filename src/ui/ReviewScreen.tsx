import { FIELD_KEYS, LIBRARY_CONTENT, buildDraft, optionLabel, selectClauses } from '../core/index.ts';
import type { AnswerInput, FieldKey, MatterState, MatterView } from '../core/index.ts';
import type { EvidenceSpan } from './reviewModel.ts';
import { fieldEvidence } from './reviewModel.ts';
import { QuestionPanel } from './QuestionPanel.tsx';
import { SourceHighlight } from './SourceHighlight.tsx';

export function FieldTable({ state, view, selected, onSelect }: { readonly state: MatterState; readonly view: MatterView; readonly selected: FieldKey | null; readonly onSelect: (key: FieldKey) => void }) {
  return <section className="card"><div className="section-heading"><div><div className="eyebrow">Grounded facts</div><h2>Fields, with receipts</h2></div><span className="count">15 fields</span></div><p className="small muted">Select a row to highlight its exact source evidence. Answers and computed values are labelled.</p>
    <div className="table-scroll"><table><thead><tr><th>Field</th><th>Value / reading</th><th>State</th></tr></thead><tbody>{FIELD_KEYS.map((key) => {
      const field = view.fields[key];
      const evidence = fieldEvidence(state.fields[key]);
      return <tr key={key} className={selected === key ? 'selected-row' : ''}><th scope="row"><button className="field-select" onClick={() => onSelect(key)} aria-pressed={selected === key}>{key.replaceAll('_', ' ')}</button></th><td>
        <div>{field.state === 'none_confirmed' ? 'None — explicitly confirmed' : field.value !== undefined ? optionLabel(key, field.value) : 'Needs confirmation'}</div>
        <div className="small muted">{field.method?.replaceAll('_', ' ') ?? 'unresolved'}{evidence.length ? ` · ${evidence.length} source span${evidence.length === 1 ? '' : 's'}` : ''}</div>
        {field.reasons.length > 0 && <div className="small muted">{field.reasons.join(' · ').replaceAll('_', ' ')}</div>}
        {selected === key && evidence.map((span) => <blockquote className="evidence" key={`${span.pointer}-${span.quote}`}>“{span.quote}”<cite>{span.pointer}</cite></blockquote>)}
      </td><td><span className={`status status-${field.state}`}>{field.state.replaceAll('_', ' ')}</span></td></tr>;
    })}</tbody></table></div>
  </section>;
}

export function NotIncludedPanel({ view, busy, onConfirm }: { readonly view: MatterView; readonly busy: boolean; readonly onConfirm: (id: string) => void }) {
  return <section className="card"><div className="section-heading"><div><div className="eyebrow">Requested terms</div><h2>What is and isn’t included</h2></div></div>
    {view.requests.accepted.length > 0 && <div className="success-note">{view.requests.accepted.length} supported request(s) explicitly confirmed.</div>}
    {view.requests.accepted.map((item) => <article className="request" key={item.id}><span className="status status-valid">Confirmed</span><h3>{item.clause_id}</h3><blockquote>“{item.quote}”</blockquote><code>{item.pointer}</code></article>)}
    {view.requests.notIncluded.length === 0 ? <p className="muted">No excluded requests.</p> : view.requests.notIncluded.map((item) => <article className="request" key={item.id}><span className="status status-ambiguous">Not included</span><blockquote>“{item.quote}”</blockquote><p className="small">{item.reason.replaceAll('_', ' ')}{item.clause_id ? ` · ${item.clause_id}` : ''}</p><code>{item.pointer}</code>
      {item.confirmable && item.reason === 'not_confirmed' && <button className="secondary" disabled={busy} onClick={() => onConfirm(item.id)}>Confirm supported clause</button>}
    </article>)}<p className="small muted">Unsupported text is kept here and in provenance. It never becomes agreement wording.</p>
  </section>;
}

export function Preview({ state, matterId }: { readonly state: MatterState; readonly matterId: string }) {
  const draft = buildDraft(state, { matterId });
  return <section className="card document-preview" id="preview"><div className="section-heading"><div><div className="eyebrow">03 · Review</div><h2>Your agreement preview</h2></div><span className="status status-ambiguous">Illustrative draft</span></div>
    {draft.ok ? <pre className="agreement-text">{draft.markdown}</pre> : <div className="empty-preview"><div className="document-glyph" aria-hidden="true">≡</div><h3>{draft.reasons.includes('library_unlocked') ? 'The clause library needs its first lock' : 'Resolve the remaining details'}</h3><p>{draft.reasons.includes('library_unlocked') ? 'This construction copy deliberately ships with an UNLOCKED library. During activation, run npm run lock, review its diff, and commit the lock before creating agreement files.' : 'The preview opens once every required field and confirmation is resolved.'}</p><details><summary>Blocking reasons ({draft.reasons.length})</summary><ul>{draft.reasons.map((reason) => <li key={reason}><code>{reason}</code></li>)}</ul></details></div>}
  </section>;
}

export function ClauseList({ view }: { readonly view: MatterView }) {
  const clauses = selectClauses(LIBRARY_CONTENT, view.fields, view.requests.accepted.map((r) => r.clause_id));
  return <section className="card"><div className="eyebrow">Library selection</div><h2>Selected clauses</h2><p className="small muted">{view.questions.length ? 'Provisional while questions remain. ' : ''}The final bytes must match the verified library and independent gate.</p><ol className="clause-list">{clauses.map((clause) => <li key={clause.id}><span>{clause.title}</span><small>{clause.category} · v{clause.version}</small></li>)}</ol></section>;
}

export function ProvenancePanel({ state, matterId }: { readonly state: MatterState; readonly matterId: string }) {
  const draft = buildDraft(state, { matterId });
  return <section className="card"><div className="eyebrow">Audit trail</div><h2>Provenance</h2><p className="small muted">Source quotes remain in this review and provenance.json. The agreement contains locked text and validated values.</p><details><summary>{draft.ok ? 'View final provenance.json' : 'View canonical state (provenance pending library lock)'}</summary><pre className="json-view">{JSON.stringify(draft.ok ? draft.provenance : state, null, 2)}</pre></details></section>;
}

export function ReviewScreen({ state, matterId, view, selected, busy, onSelect, onAnswer, onConfirm, onEdit }: {
  readonly state: MatterState; readonly matterId: string; readonly view: MatterView; readonly selected: FieldKey | null; readonly busy: boolean;
  readonly onSelect: (key: FieldKey) => void; readonly onAnswer: (id: string, input: AnswerInput) => void; readonly onConfirm: (id: string) => void;
  readonly onEdit: () => void;
}) {
  const evidence: readonly EvidenceSpan[] = selected ? fieldEvidence(state.fields[selected]) : [];
  return <><div className="workbench-grid"><div className="stack"><section className="card source-card"><div className="eyebrow">Evidence desk</div><h2>Back to the source</h2><p className="small muted">{selected ? `Showing evidence for ${selected.replaceAll('_', ' ')}.` : 'Select a field to highlight its source.'} Offsets refer to normalized messages.</p><SourceHighlight messages={state.intake} evidence={evidence} /></section><NotIncludedPanel view={view} busy={busy} onConfirm={onConfirm} /><ClauseList view={view} /></div><div className="stack"><QuestionPanel questions={view.questions} state={state} busy={busy} onAnswer={onAnswer} onEdit={onEdit} /><FieldTable state={state} view={view} selected={selected} onSelect={onSelect} /></div></div><Preview state={state} matterId={matterId} /><ProvenancePanel state={state} matterId={matterId} /></>;
}
