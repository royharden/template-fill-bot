import { useCallback, useMemo, useState } from 'react';
import { SupabaseStore } from '../store/SupabaseStore.ts';
import { App } from './App.tsx';
import { AuthScreens } from './AuthScreens.tsx';
import type { LiveConnection } from './AuthScreens.tsx';
import type { LiveControls } from './live.ts';
import { createLiveExtraction } from './liveExtraction.ts';

// No public env is used to guess an actual receiver. The server can select either LLM provider.
export const LIVE_PROVIDER_DISCLOSURE = 'the server-configured provider: Anthropic or the operator’s OpenAI-compatible endpoint for LLM; TypeSafe for Jev (confirm the configured endpoint with the operator before sending personal data)';
export function LiveWorkbench() {
  const [active, setActive] = useState(false);
  const [connection, setConnection] = useState<LiveConnection | null>(null);
  const onConnection = useCallback((next: LiveConnection | null) => setConnection(next), []);
  const onLiveChange = useCallback((next: boolean) => { setActive(next); if (!next) setConnection(null); }, []);
  const store = useMemo(() => active && connection?.session ? new SupabaseStore(connection.client) : null, [active, connection?.client, connection?.session?.user.id]);
  const extract = useMemo(() => store && connection ? createLiveExtraction(connection.client, store) : undefined, [store, connection?.client]);
  const live: LiveControls = {
    session: active && connection?.session ? { userId: connection.session.user.id } : null,
    store, providerLabel: LIVE_PROVIDER_DISCLOSURE, extract,
    authContent: active ? <AuthScreens onConnection={onConnection} /> : undefined,
  };
  return <App live={live} onLiveChange={onLiveChange} />;
}
