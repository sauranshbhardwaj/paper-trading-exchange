import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { defaultSocketUrl, RealtimeClient, type ConnectionStatus } from '../lib/realtime.ts';

interface RealtimeValue {
  client: RealtimeClient;
  status: ConnectionStatus;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new RealtimeClient(defaultSocketUrl()));
  const [status, setStatus] = useState<ConnectionStatus>(client.status);

  useEffect(() => {
    const stop = client.onStatus(setStatus);
    client.connect();
    return stop;
  }, [client]);

  return <RealtimeContext.Provider value={{ client, status }}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return value;
}
