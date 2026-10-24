import { useState } from 'react';
import { UTILITY_CATEGORIES, optionLabel } from '../core/index.ts';
import type { AnswerInput, GroundedField, MatterState, Question, UtilityCategory } from '../core/index.ts';
import { answeredQuestions } from './reviewModel.ts';

const ENUMS: Readonly<Record<string, readonly string[]>> = {
  pets: ['none', 'with_consent'], smoking: ['prohibited', 'permitted_outside'], furnished: ['furnished', 'unfurnished'],
};
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  monthly_rent: 'GBP 1200', deposit: 'GBP 1200', start_date: '2027-04-03', address: '14 Elm Road, Flat 2, Oxtown',
  tenants: 'Priya Shah and Joe Bloggs', term_months: '12 months', rent_due_day: 'due day 1', break_month: '6 months',
};

function QuestionCard({ question: q, state, busy, answer, onEdit, editing = false }: {
  readonly question: Question; readonly state: MatterState; readonly busy: boolean; readonly editing?: boolean;
  readonly answer: (id: string, input: AnswerInput) => void;
  readonly onEdit: () => void;
}) {
  const field = q.fields[0];
  const current: GroundedField = state.fields[field];
  const [text, setText] = useState('');
  const [utilities, setUtilities] = useState<readonly UtilityCategory[]>(Array.isArray(current.value) && field === 'utilities' ? current.value.filter((v): v is UtilityCategory => (UTILITY_CATEGORIES as readonly string[]).includes(v)) : current.utilities?.tenant_pays ?? []);
  const [guarantor, setGuarantor] = useState(typeof state.fields.guarantor.value === 'string' ? state.fields.guarantor.value : '');
  const [breakMonth, setBreakMonth] = useState(state.fields.break_month.value === undefined ? '' : String(state.fields.break_month.value));
  const enumValues = ENUMS[field];
  const send = (input: AnswerInput): void => answer(q.id, input);
  return <article className={`question-card ${editing ? 'answered-card' : ''}`}>
    <div className="eyebrow">{editing ? 'Edit previous answer' : 'Confirmation needed'} · {q.fields.join(' + ').replaceAll('_', ' ')}</div>
    <h3>{q.text}</h3>
    {q.reasons.length > 0 && <p className="small muted">{q.reasons.join(' · ').replaceAll('_', ' ')}</p>}
    {!editing && q.options.length > 0 && <div className="option-list">{q.options.map((option) => <button className="option" key={option.id} disabled={busy} onClick={() => send({ kind: 'option', option_id: option.id })}>{option.label}<span aria-hidden="true">↗</span></button>)}</div>}
    {q.kind === 'optional_terms' ? <form onSubmit={(event) => {
      event.preventDefault();
      send({ kind: 'optional_terms', ...(q.fields.includes('guarantor') ? { guarantor: guarantor.trim() || null } : {}), ...(q.fields.includes('break_month') ? { break_month: breakMonth.trim() || null } : {}) });
    }}>
      <p className="small">Leave a term blank to explicitly confirm none.</p>
      {q.fields.includes('guarantor') && <label>Guarantor full name<input disabled={busy} value={guarantor} onChange={(e) => { onEdit(); setGuarantor(e.target.value); }} placeholder="None" maxLength={200} /></label>}
      {q.fields.includes('break_month') && <label>Break clause after month<input disabled={busy} value={breakMonth} onChange={(e) => { onEdit(); setBreakMonth(e.target.value); }} placeholder="None" maxLength={50} /></label>}
      <button className="secondary" disabled={busy} type="submit">Save optional terms</button>
    </form> : field === 'utilities' ? <form onSubmit={(event) => { event.preventDefault(); send({ kind: 'value', value: [...utilities] }); }}>
      <fieldset disabled={busy}><legend>Tenant pays (all unchecked categories are included in rent)</legend><div className="checks">{UTILITY_CATEGORIES.map((category) => <label className="check" key={category}><input type="checkbox" checked={utilities.includes(category)} onChange={(e) => { onEdit(); setUtilities(e.target.checked ? UTILITY_CATEGORIES.filter((v) => utilities.includes(v) || v === category) : utilities.filter((v) => v !== category)); }} />{category}</label>)}</div></fieldset>
      <button className="secondary" disabled={busy} type="submit">Confirm all four utilities</button>
    </form> : enumValues ? <div className="option-list">{(editing ? enumValues : []).map((value) => <button className="option" disabled={busy} key={value} onClick={() => send({ kind: 'value', value })}>{optionLabel(field, value)}</button>)}</div> : <form className="manual-answer" onSubmit={(event) => { event.preventDefault(); send({ kind: 'text', text }); }}>
      <label>{editing ? 'Replacement answer' : 'Or enter an answer'}<input disabled={busy} value={text} onChange={(event) => { onEdit(); setText(event.target.value); }} placeholder={PLACEHOLDERS[field] ?? 'Enter a value'} maxLength={500} required /></label>
      {['landlord', 'tenants', 'address', 'guarantor'].includes(field) && <p className="small muted">Use plain names and addresses, such as St Johns Rd; periods and clause sentences are rejected.</p>}
      <button className="secondary" disabled={busy || !text.trim()} type="submit">Save answer</button>
      {['guarantor', 'break_month'].includes(field) && <button type="button" className="text-button" disabled={busy} onClick={() => send({ kind: 'none' })}>Confirm none</button>}
    </form>}
  </article>;
}

export function QuestionPanel({ questions, state, busy, onAnswer, onEdit }: { readonly questions: readonly Question[]; readonly state: MatterState; readonly busy: boolean; readonly onAnswer: (id: string, input: AnswerInput) => void; readonly onEdit: () => void }) {
  const past = answeredQuestions(state);
  return <section className="card" id="questions"><div className="section-heading"><div><div className="eyebrow">02 · Resolve</div><h2>A few details to confirm</h2></div><span className="count">{questions.length} open</span></div>
    <p className="muted">Every open question needs an answer. Your choices become part of this revision’s provenance.</p>
    {questions.length === 0 && <div className="success-note">All questions resolved. Review the fields and requested terms before generating your bundle.</div>}
    {questions.map((q) => <QuestionCard key={`${q.id}-${state.revision}`} question={q} state={state} busy={busy} answer={onAnswer} onEdit={onEdit} />)}
    {past.length > 0 && <details><summary>Edit previous answers ({past.length})</summary><p className="small muted">Saving a change creates a new revision and requires a new bundle and approval.</p>{past.map((q) => <QuestionCard key={`${q.id}-${state.revision}`} question={q} state={state} busy={busy} answer={onAnswer} onEdit={onEdit} editing />)}</details>}
  </section>;
}
