import type { ConnectionStatus } from '../lib/realtime.ts';

const LABELS: Record<ConnectionStatus, string> = {
  open: 'Live',
  connecting: 'Connecting…',
  closed: 'Offline',
};

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  return (
    <span className={`connection connection-${status}`} role="status" aria-live="polite">
      <span className="connection-dot" aria-hidden />
      {LABELS[status]}
    </span>
  );
}
