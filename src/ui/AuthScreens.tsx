import { useEffect, useState } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from '../lib/supabase.ts';

export interface LiveConnection { readonly client: SupabaseClient; readonly session: Session | null; }
export function AuthScreens({ onConnection }: { readonly onConnection: (connection: LiveConnection | null) => void }) {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [recovery, setRecovery] = useState(false), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('Recovering your saved session…'), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // This component mounts only after the user selects Live. Default demo never calls this getter.
    const next = getSupabaseClient(); setClient(next);
    if (!next) { setNotice('Live configuration is missing. Continue in demo mode or complete setup.'); return; }
    let alive = true, epoch = 0;
    const verify = async (candidate: Session | null): Promise<void> => {
      const ticket = ++epoch;
      if (candidate) {
        const { data, error: failure } = await next.auth.getUser(candidate.access_token);
        if (failure || data.user?.id !== candidate.user.id) candidate = null;
      }
      if (!alive || ticket !== epoch) return;
      setSession(candidate); onConnection({ client: next, session: candidate });
      setNotice(candidate ? 'Signed in. Saved matters are private to your account.' : 'Sign in to save matters and use live extraction.');
    };
    const { data: listener } = next.auth.onAuthStateChange((event, candidate) => {
      // Do not await other auth calls inside Supabase's auth callback (its session lock may be held).
      if (event === 'PASSWORD_RECOVERY' && alive) setRecovery(true);
      queueMicrotask(() => { if (alive) void verify(candidate); });
    });
    next.auth.startAutoRefresh();
    void next.auth.getSession().then(({ data, error: failure }) => {
      if (failure && alive) { setError('Session recovery failed. Sign in again.'); }
      return verify(failure ? null : data.session);
    }).catch(() => { if (alive) setError('Session recovery failed. Sign in again.'); });
    return () => { alive = false; epoch += 1; listener.subscription.unsubscribe(); next.auth.stopAutoRefresh(); };
  }, [onConnection]);
  async function auth(action: 'signin' | 'signup' | 'logout' | 'reset' | 'update'): Promise<void> {
    if (!client || busy) return;
    setBusy(true); setError(null);
    try {
      const redirectTo = `${window.location.origin}${window.location.pathname}`;
      const result = action === 'signin' ? await client.auth.signInWithPassword({ email: email.trim(), password })
        : action === 'signup' ? await client.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: redirectTo } })
          : action === 'reset' ? await client.auth.resetPasswordForEmail(email.trim(), { redirectTo })
            : action === 'update' ? await client.auth.updateUser({ password }) : await client.auth.signOut();
      if (result.error) throw new Error('auth_failed');
      setPassword('');
      if (action === 'reset') setNotice('If this account exists, a recovery email has been requested. Open its link, select Live, then set a new password.');
      if (action === 'signup') setNotice('Account request accepted. Check your email for confirmation if required, then sign in.');
      if (action === 'update') { setRecovery(false); setNotice('Password updated.'); }
      if (action === 'logout') { setSession(null); onConnection({ client, session: null }); setNotice('Signed out.'); }
    } catch { setError('Authentication could not be completed. Check your details, email settings, and connection.'); }
    finally { setBusy(false); }
  }
  return <div className="auth-panel"><p role="status">{notice}</p>{error && <p role="alert" className="error-banner">{error}</p>}
    {client && (session && !recovery ? <div><p className="small">Signed in as {session.user.email ?? 'your account'}.</p><button className="secondary" disabled={busy} onClick={() => { void auth('logout'); }}>Sign out</button></div>
      : <form onSubmit={(event) => { event.preventDefault(); void auth(recovery ? 'update' : 'signin'); }}>
        {!recovery && <label>Email<input type="email" autoComplete="email" required value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} /></label>}
        <label>{recovery ? 'New password' : 'Password'}<input type="password" autoComplete={recovery ? 'new-password' : 'current-password'} minLength={8} required value={password} disabled={busy} onChange={(event) => setPassword(event.target.value)} /></label>
        <div className="toolbar"><button className="primary" disabled={busy} type="submit">{recovery ? 'Set new password' : 'Sign in'}</button>{!recovery && <><button className="secondary" type="button" disabled={busy || !email.trim() || password.length < 8} onClick={() => { void auth('signup'); }}>Create account</button><button className="text-button" type="button" disabled={busy || !email.trim()} onClick={() => { void auth('reset'); }}>Send password reset</button></>}</div>
      </form>)}
  </div>;
}
