import { createClient } from '@supabase/supabase-js';
import { EdgeError, handle } from './handler.ts';
import type { HandlerDeps } from './handler.ts';
import { selectServerProvider, serverCaps } from './configuration.ts';
import type { ReserveResult } from '../_shared/callledger/types.ts';

// Deno globals intentionally confined to the deploy entrypoint (deno check separately at activation).
const env = (name: string): string | undefined => Deno.env.get(name);
const required = (name: string): string => { const value = env(name)?.trim(); if (!value) throw new EdgeError(503, 'backend_not_configured'); return value; };
function dependencies(): HandlerDeps {
  const url = required('SUPABASE_URL'), anon = required('SUPABASE_ANON_KEY');
  const admin = createClient(url, required('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  const scoped = (token: string) => createClient(url, anon, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
  return {
    allowedOrigins: (env('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s) && s !== '*'),
    caps: serverCaps(env), uuid: () => crypto.randomUUID(),
    async authenticate(token) { const { data, error } = await scoped(token).auth.getUser(token); return error || !data.user ? null : { id: data.user.id }; },
    async readInput(token, matterId) {
      const client = scoped(token);
      const { data: matter, error } = await client.from('matters').select('revision').eq('id', matterId).maybeSingle();
      if (error) throw new EdgeError(503, 'storage_unavailable'); if (!matter) return null;
      const { data: messages, error: messagesError } = await client.from('messages').select('id,text_normalised').eq('matter_id', matterId).order('ord');
      if (messagesError) throw new EdgeError(503, 'storage_unavailable');
      const { data: after, error: afterError } = await client.from('matters').select('revision').eq('id', matterId).maybeSingle();
      if (afterError) throw new EdgeError(503, 'storage_unavailable');
      if (!after || after.revision !== matter.revision) throw new EdgeError(409, 'stale_revision');
      return { revision: matter.revision as number, messages: messages ?? [] };
    },
    select: (method) => selectServerProvider(method, env),
    async reserve(input) {
      const { data, error } = await admin.rpc('reserve_attempt', { p_owner: input.owner, p_request_id: input.requestId, p_input_hash: input.inputHash, p_max_cost_usd: input.maxCost, p_caps: input.caps });
      if (error || !data) throw new EdgeError(503, 'quota_unavailable'); return data as ReserveResult;
    },
    async settle(requestId, actual, status) {
      const { error } = await admin.rpc('settle_attempt', { p_request_id: requestId, p_actual_usd: actual, p_status: status });
      if (error) throw new EdgeError(503, 'settlement_unavailable');
    },
    async writeLedger(row) { const { error } = await admin.from('call_ledger').insert(row); if (error) throw new EdgeError(503, 'ledger_unavailable'); },
  };
}
Deno.serve(async (req: Request) => {
  try { return await handle(req, dependencies()); }
  catch { return new Response(JSON.stringify({ error: { code: 'backend_not_configured', message: 'Backend configuration is incomplete.', retryable: false }, request_id: null }), { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } }); }
});
