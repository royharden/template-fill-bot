import { useEffect, useRef, useState } from 'react';
import { applyAnswer, approveBundle, approvalMatches, buildBundle, confirmRequest, createMockExtractor, deriveView, normaliseIntake, regexExtractor } from '../core/index.ts';
import type { AnswerInput, Bundle, BundleApproval, BundleFilename, BundleResult, FieldKey, IntakeMessageInput, MatterState } from '../core/index.ts';
import { downloadApproved, downloadStateJson } from '../export/download.ts';
import { liveConfigured } from '../lib/supabase.ts';
import { MemoryStore } from '../store/MemoryStore.ts';
import type { MatterRecord } from '../store/Store.ts';
import { exportMatterJson, importMatterJson } from '../store/jsonImportExport.ts';
import { AdversarialDemo } from './AdversarialDemo.tsx';
import { ApprovalBar } from './ApprovalBar.tsx';
import { DEMOS } from './fixtures.ts';
import type { LiveControls } from './live.ts';
import { extractMatter } from './reviewModel.ts';
import { ReviewScreen } from './ReviewScreen.tsx';

const EMPTY_LIVE: LiveControls = { session: null, store: null, providerLabel: 'the configured extraction provider' };
const emptyMessages = (): IntakeMessageInput[] => [{ id: 'm1', text: '' }];

export function App({ live = EMPTY_LIVE, onLiveChange }: { readonly live?: LiveControls; readonly onLiveChange?: (active: boolean) => void }) {
  const [demoStore] = useState(() => new MemoryStore());
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [method, setMethod] = useState<'mock' | 'regex' | 'llm' | 'jev'>('mock');
  const [messages, setMessages] = useState<readonly IntakeMessageInput[]>(emptyMessages);
  const [scenario, setScenario] = useState('demo-01');
  const [matterId, setMatterId] = useState<string | null>(null);
  const [state, setState] = useState<MatterState | null>(null);
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [approval, setApproval] = useState<BundleApproval | null>(null);
  const [gateResult, setGateResult] = useState<BundleResult | null>(null);
  const [dirty, setDirty] = useState(true);
  const [unsavedAnswers, setUnsavedAnswers] = useState(false);
  const [formEpoch, setFormEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('Load an example, or paste your own tenancy messages.');
  const [selected, setSelected] = useState<FieldKey | null>(null);
  const [approver, setApprover] = useState('');
  const [matters, setMatters] = useState<MatterRecord[]>([]);
  const [importText, setImportText] = useState('');
  const [consentKey, setConsentKey] = useState<string | null>(null);
  const actionLock = useRef(false);
  const generation = useRef(0);
  const scopeGeneration = useRef(0);
  const store = mode === 'demo' ? demoStore : live.store;
  const liveReady = Boolean(liveConfigured && live.session && live.store && live.extract);
  const providerKey = `${live.session?.userId ?? ''}:${live.providerLabel}`;
  const activeScope = useRef({ mode, store, userId: live.session?.userId, providerLabel: live.providerLabel });
  // Ref invalidation happens during the auth render, before effects: an awaited download cannot slip
  // through between a changed session render and the cleanup effect below.
  if (activeScope.current.mode !== mode || activeScope.current.store !== store || (mode === 'live' && (activeScope.current.userId !== live.session?.userId || activeScope.current.providerLabel !== live.providerLabel))) {
    generation.current += 1;
    scopeGeneration.current += 1;
    activeScope.current = { mode, store, userId: live.session?.userId, providerLabel: live.providerLabel };
  }
  const view = state ? deriveView(state) : null;
  const norm = normaliseIntake(messages);
  const mockMatches = JSON.stringify(messages) === JSON.stringify(DEMOS[scenario].messages);

  function invalidate(): void {
    generation.current += 1;
    setBundle(null); setApproval(null); setGateResult(null);
  }
  function clearReview(): void {
    invalidate(); setState(null); setSelected(null); setDirty(true); setUnsavedAnswers(false);
  }
  function clearScope(): void {
    clearReview(); setMatterId(null); setMatters([]); setConsentKey(null);
    setMessages(emptyMessages()); setImportText(''); setApprover(''); setError(null);
    setFormEpoch((value) => value + 1);
  }
  // Clear both saved-review views and unsaved editor buffers when the live account scope changes.
  useEffect(() => {
    if (mode !== 'live') return;
    clearScope();
    setNotice(live.session ? 'Signed in. Confirm the provider disclosure before live extraction.' : 'Sign in and confirm the provider disclosure before live extraction.');
  }, [mode, live.session?.userId, live.store, live.providerLabel]);

  async function refreshMatters(): Promise<void> {
    if (!store) return;
    const ticket = generation.current;
    const saved = await store.listMatters();
    if (ticket === generation.current) setMatters(saved);
  }
  async function action(work: () => Promise<void>): Promise<void> {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(true); setError(null);
    const scopeTicket = scopeGeneration.current;
    try { await work(); }
    catch (cause) { if (scopeTicket === scopeGeneration.current) setError(cause instanceof Error ? cause.message : 'The action could not be completed.'); }
    finally { actionLock.current = false; setBusy(false); }
  }
  function chooseMode(next: 'demo' | 'live'): void {
    if (next === mode) return;
    onLiveChange?.(next === 'live');
    clearScope(); setMode(next); setMethod(next === 'demo' ? 'mock' : 'llm');
    setNotice(next === 'demo' ? 'Demo mode is local and in memory.' : 'Sign in and confirm the provider disclosure before live extraction.');
  }
  function editMessages(next: readonly IntakeMessageInput[]): void {
    clearReview(); setMessages(next);
    setNotice('Intake changed. Previous downloads are disabled. Extract to save a new canonical revision.');
  }
  function loadDemo(id: string): void {
    onLiveChange?.(false);
    clearScope(); setMode('demo'); setMethod('mock'); setScenario(id); setMessages(DEMOS[id].messages);
    setNotice(`${id} loaded. Extract to find its questions and grounded evidence.`);
  }
  async function extract(): Promise<void> {
    if (!store) throw new Error('Live storage is not configured.');
    if (!norm.ok) throw new Error(`Intake: ${norm.error.code} (${norm.error.detail})`);
    invalidate(); const ticket = generation.current;
    let result: { readonly matterId: string; readonly state: MatterState };
    if (mode === 'demo') {
      if (method !== 'mock' && method !== 'regex') throw new Error('Demo mode supports mock and regex only.');
      if (method === 'mock' && !mockMatches) throw new Error('Mock replay requires unchanged demo messages. Reload an example, or choose regex.');
      result = await extractMatter(store, messages, method === 'regex' ? regexExtractor : createMockExtractor(DEMOS[scenario], scenario), matterId);
    } else {
      if (!liveReady || !live.extract || !live.session || consentKey !== providerKey) throw new Error('Sign in and acknowledge the provider disclosure first.');
      if (method !== 'llm' && method !== 'jev') throw new Error('Choose a live extraction method.');
      result = await live.extract(messages, method, matterId);
      // M6b owns persisting messages + canonical state in the signed-in store.
      if ((await store.getState(result.matterId))?.revision !== result.state.revision) throw new Error('Live extraction state was not persisted.');
    }
    if (ticket !== generation.current) return;
    setMatterId(result.matterId); setState(result.state); setDirty(false); setUnsavedAnswers(false); setSelected('monthly_rent');
    setNotice(`Revision ${result.state.revision} saved. Resolve the questions, then inspect your draft.`);
    await refreshMatters();
  }
  async function answer(id: string, input: AnswerInput): Promise<void> {
    if (!state || !store || !matterId || dirty) throw new Error('Extract the current intake first.');
    const result = applyAnswer(state, id, input);
    if (!result.ok) throw new Error(`Answer rejected: ${result.error.code} (${result.error.detail})`);
    invalidate(); const ticket = generation.current;
    await store.saveState(matterId, result.state);
    if (ticket !== generation.current) return;
    setState(result.state); setUnsavedAnswers(false); setNotice(`Answer saved as revision ${result.state.revision}. Previous bundle approval no longer applies.`);
  }
  async function confirm(id: string): Promise<void> {
    if (!state || !store || !matterId || dirty) throw new Error('Extract the current intake first.');
    const result = confirmRequest(state, id);
    if (!result.ok) throw new Error(`Request cannot be confirmed: ${result.error.code}`);
    invalidate(); const ticket = generation.current;
    await store.saveState(matterId, result.state);
    if (ticket !== generation.current) return;
    setState(result.state); setUnsavedAnswers(false); setNotice(`Supported request confirmed in revision ${result.state.revision}.`);
  }
  async function generate(): Promise<void> {
    if (!state || !store || !matterId || dirty || unsavedAnswers) throw new Error('Save or discard draft answers and extract the current intake first.');
    invalidate(); const ticket = generation.current;
    const saved = await store.getState(matterId);
    if (!saved || saved.revision !== state.revision) throw new Error('Stored revision changed. Reopen the saved matter.');
    const result = buildBundle(saved, { matterId });
    const approvals = result.ok ? await store.listApprovals(matterId) : [];
    if (ticket !== generation.current) return;
    setGateResult(result); setBundle(result.ok ? result.bundle : null);
    setApproval(result.ok ? approvals.find((row) => approvalMatches(row, result.bundle, matterId, saved.revision)) ?? null : null);
    setNotice(result.ok ? 'Bundle generated and independently checked. Review the preview and digest before approval.' : 'Generation is blocked. Review the gate reasons below.');
  }
  async function approve(): Promise<void> {
    if (!bundle || !state || !store || !matterId || dirty || unsavedAnswers || bundle.manifest.revision !== state.revision) throw new Error('Generate the current bundle first.');
    if (mode === 'live' && !live.session) throw new Error('An actual signed-in session is required.');
    const ticket = generation.current;
    const row = await approveBundle(store, matterId, bundle, mode === 'live' ? live.session!.userId : approver.trim());
    if (ticket !== generation.current) return;
    const recorded = mode === 'live' ? (await store.listApprovals(matterId)).filter((entry) => approvalMatches(entry, bundle, matterId, state.revision)).at(-1) : row;
    if (ticket !== generation.current) return;
    if (!recorded) throw new Error('Server approval receipt is missing.');
    setApproval(recorded); setNotice('This exact revision and digest are approved. Downloads recheck the canonical saved state.');
  }
  async function download(filename: BundleFilename): Promise<void> {
    if (!bundle || !store || !matterId || dirty || unsavedAnswers) throw new Error('Current approved bundle required.');
    const ticket = generation.current;
    await downloadApproved(store, matterId, bundle, filename, () => ticket === generation.current);
  }
  async function resume(id: string): Promise<void> {
    if (!store || !id) return;
    invalidate(); const ticket = generation.current;
    const saved = await store.getState(id);
    if (!saved) throw new Error('Saved canonical state is missing.');
    const result = buildBundle(saved, { matterId: id });
    const approvals = result.ok ? await store.listApprovals(id) : [];
    if (ticket !== generation.current) return;
    setMatterId(id); setState(saved); setMessages(saved.intake.map((message) => ({ id: message.id, text: message.text_normalised }))); setDirty(false); setUnsavedAnswers(false); setSelected(null);
    setMethod(saved.extractor_method === 'regex' ? 'regex' : mode === 'demo' ? 'mock' : 'llm');
    setGateResult(result); setBundle(result.ok ? result.bundle : null); setApproval(result.ok ? approvals.find((row) => approvalMatches(row, result.bundle, id, saved.revision)) ?? null : null);
    setNotice(`Reopened revision ${saved.revision}. Bytes regenerated from saved state; no extractor was called.`);
  }
  async function importState(text: string): Promise<void> {
    if (mode !== 'demo') throw new Error('Switch to demo mode to import a local state.');
    const imported = importMatterJson(text);
    invalidate(); const ticket = generation.current;
    const matter = await demoStore.createMatter({ title: 'Imported tenancy draft' });
    await demoStore.saveState(matter.id, imported);
    if (ticket !== generation.current) return;
    setMatterId(matter.id); setState(imported); setDirty(false); setUnsavedAnswers(false); setSelected(null); setMessages(imported.intake.map((m) => ({ id: m.id, text: m.text_normalised }))); setMethod(imported.extractor_method === 'regex' ? 'regex' : 'mock'); setImportText('');
    setNotice('Validated state imported into a new demo matter. Approval history was discarded. Generate and approve a fresh bundle.');
    const savedMatters = await demoStore.listMatters();
    if (ticket === generation.current) setMatters(savedMatters);
  }

  return <><header className="topbar"><a href="#top" className="brand"><span className="brand-mark" aria-hidden="true">▤</span><span>Accord<span className="brand-subtitle">Template-filling workbench</span></span></a><div className="mode-switch" aria-label="Working mode"><button aria-pressed={mode === 'demo'} disabled={busy} onClick={() => chooseMode('demo')}>Demo / dry run</button><button aria-pressed={mode === 'live'} disabled={busy} onClick={() => chooseMode('live')}>Live</button></div></header>
    <main id="top"><section className="hero"><div className="eyebrow">Messages → evidence → a reviewed draft</div><h1>Make the details<br /><em>agree.</em></h1><p>A considered tenancy draft, built from validated facts and a fixed clause library. Every value has a source. Every uncertain detail gets a question.</p><div className="mode-banner"><span className="mode-dot" />{mode === 'demo' ? `Demo mode · in-memory · ${state?.extractor_method ?? method} extractor` : `Live mode · ${live.session ? 'signed in' : 'sign-in required'}`}</div><div className="legal-banner">Illustrative jurisdiction · draft, not legal advice</div></section>
      <nav className="journey" aria-label="Drafting steps"><a href="#intake"><b>01</b><span>Gather messages<small>Keep the source close</small></span></a><a href="#questions"><b>02</b><span>Confirm the facts<small>Resolve each open question</small></span></a><a href="#preview"><b>03</b><span>Review the agreement<small>Locked text, checked bytes</small></span></a><a href="#downloads"><b>04</b><span>Approve & export<small>Bound to this exact revision</small></span></a></nav>
      {mode === 'live' && <section className="card live-panel"><h2>Live extraction setup</h2><p>Intake text will be sent to <strong>{live.providerLabel}</strong> for extraction. The provider proposes values and quotes; the local core validates them.</p>{!liveConfigured && <p className="blocked-note">Not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY during activation, then configure the backend. Demo mode works without credentials.</p>}{!live.session && <p className="small">An actual signed-in session is required. Configuration alone does not sign you in.</p>}{live.authContent}{!live.extract && <p className="small muted">Live extraction is not connected in this copy. Connect authentication and the backend during setup.</p>}<label className="check"><input type="checkbox" disabled={busy || !liveReady} checked={consentKey === providerKey} onChange={(event) => setConsentKey(event.target.checked ? providerKey : null)} />I understand that intake text will be sent to {live.providerLabel}.</label></section>}
      <div className="notice" role="status" aria-live="polite">{busy ? 'Saving and checking…' : notice}</div>{error && <div className="error-banner" role="alert"><strong>Action stopped.</strong> {error}</div>}
      <section className="card intake-card" id="intake"><div className="section-heading"><div><div className="eyebrow">01 · Gather</div><h2>Start with the conversation</h2></div><span className="count">{messages.length}/12 messages</span></div><p className="muted">Paste messages in their original order. Up to 8,000 normalized UTF-16 characters in total.</p><div className="toolbar"><button className="secondary" disabled={busy} onClick={() => loadDemo('demo-01')}>Load demo-01 · natural conversation</button><button className="secondary" disabled={busy} onClick={() => loadDemo('demo-02')}>Load demo-02 · dates & utilities</button><button className="text-button" disabled={busy} onClick={() => { clearReview(); setMatterId(null); setMessages(emptyMessages()); setNotice('New matter. Paste the messages to begin.'); }}>New matter</button></div>
        <fieldset disabled={busy}><legend className="sr-only">Tenancy messages</legend><div className="intake-messages">{messages.map((message, index) => <div className="intake-message" key={index}><label>Message {index + 1}<textarea rows={3} value={message.text} maxLength={8000} placeholder="Paste one message here…" onChange={(event) => editMessages(messages.map((m, i) => i === index ? { ...m, text: event.target.value } : m))} /></label><button className="text-button small" disabled={messages.length === 1} onClick={() => editMessages(messages.filter((_, i) => i !== index).map((m, i) => ({ ...m, id: `m${i + 1}` })))}>Remove</button></div>)}</div></fieldset>
        <div className="intake-footer"><button className="text-button" disabled={busy || messages.length >= 12} onClick={() => editMessages([...messages, { id: `m${messages.length + 1}`, text: '' }])}>+ Add message</button><span className="small muted">{messages.reduce((sum, message) => sum + message.text.length, 0).toLocaleString()} raw UTF-16 characters</span></div>
        <div className="extract-row"><label>Extraction method<select disabled={busy} value={method} onChange={(event) => { clearReview(); setMethod(event.target.value as typeof method); }}>{mode === 'demo' ? <><option value="mock">Mock · bundled example replay</option><option value="regex">Regex · local deterministic baseline</option></> : <><option value="llm">LLM · live provider</option><option value="jev">Jev · live typed judgments</option></>}</select></label><button className="primary" disabled={busy || !norm.ok || (mode === 'demo' ? method === 'mock' && !mockMatches : !liveReady || consentKey !== providerKey)} onClick={() => { void action(extract); }}>Extract & review <span aria-hidden="true">→</span></button></div>
        {!norm.ok && <p className="small muted">Intake needs attention: {norm.error.code.replaceAll('_', ' ')}.</p>}{mode === 'demo' && method === 'mock' && !mockMatches && <p className="small muted">Load an unchanged demo for mock replay, or choose regex for your own messages.</p>}<p className="small muted">Intake edits disable downloads immediately. Extraction saves the next canonical revision; earlier snapshots remain immutable.</p>
      </section>
      <details className="card state-tools"><summary>Saved matters & portable state</summary><p className="small muted">Demo snapshots live in memory until the page closes. Export JSON to keep a portable canonical state; imports validate evidence and values and discard approvals.</p><div className="toolbar"><button className="secondary" disabled={busy || !store} onClick={() => { void action(refreshMatters); }}>Refresh saved matters</button><select aria-label="Reopen saved matter" disabled={busy || !matters.length} value="" onChange={(event) => { void action(() => resume(event.target.value)); }}><option value="">Reopen a saved matter…</option>{matters.map((matter) => <option key={matter.id} value={matter.id}>{matter.title} · {matter.id.slice(0, 8)}</option>)}</select><button className="secondary" disabled={busy || !state || dirty} onClick={() => { void action(async () => { if (state) downloadStateJson(exportMatterJson(state)); }); }}>Export canonical state JSON</button></div><label>Import a state JSON file<input type="file" accept="application/json,.json" disabled={busy || mode !== 'demo'} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void action(async () => { if (file.size > 262144) throw new Error('State file exceeds 256 KiB.'); await importState(await file.text()); }); }} /></label><label>Or paste exported state<textarea rows={4} disabled={busy || mode !== 'demo'} maxLength={262144} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder="Paste matter-state.json here" /></label><button className="secondary" disabled={busy || mode !== 'demo' || !importText.trim()} onClick={() => { void action(() => importState(importText)); }}>Validate & import without approvals</button></details>
      {unsavedAnswers && <div className="blocked-note">An answer has unsaved edits. Save an answer to create a new revision, or <button className="text-button" disabled={busy} onClick={() => { invalidate(); setUnsavedAnswers(false); setFormEpoch((value) => value + 1); }}>discard unsaved answers</button> before generating a bundle.</div>}
      {state && matterId && view ? <><div className="review-heading"><h2>Review your draft</h2><span className="status status-valid">Revision {state.revision} saved</span></div><ReviewScreen key={formEpoch} state={state} matterId={matterId} view={view} selected={selected} busy={busy} onSelect={setSelected} onAnswer={(id, input) => { void action(() => answer(id, input)); }} onConfirm={(id) => { void action(() => confirm(id)); }} onEdit={() => { invalidate(); setUnsavedAnswers(true); }} /></> : <section className="card welcome-card"><div className="document-glyph" aria-hidden="true">▤</div><h2>A clear path from conversation to draft</h2><p>Load demo-01 to explore a rent conflict, a relative deposit, qualified pets language, and the details that need your confirmation.</p><p className="small muted">Nothing is sent to a provider in demo mode. No agreement is downloadable until its final bytes pass the gate and receive approval.</p></section>}
      <ApprovalBar state={state} matterId={matterId} bundle={bundle} approval={approval} result={gateResult} busy={busy} dirty={dirty || unsavedAnswers} approver={approver} onApprover={setApprover} onGenerate={() => { void action(generate); }} onApprove={() => { void action(approve); }} onDownload={(filename) => { void action(() => download(filename)); }} />
      <AdversarialDemo key={`${matterId}-${state?.revision ?? 0}-${bundle?.digest ?? ''}`} bundle={bundle} busy={busy} />
      <footer><span className="brand-footer">Accord</span><p>Self-authored, illustrative tenancy language. A drafting demonstration, not legal advice.</p><p className="small">Construction copy · runtime validation pending · no live provider calls in demo mode</p></footer>
    </main></>;
}
