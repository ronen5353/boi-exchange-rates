import type { Rate, Status } from './api';
import { formatTime } from './money';

type Level = 'good' | 'warn' | 'bad';

function boiState(shown: Rate[], status: Status): [Level, string] {
  const last = status.lastSuccessAt ? `last reached ${formatTime(status.lastSuccessAt)}` : 'not reached since the server started';
  if (status.held.length > 0) return ['warn', `Unusual change waiting for confirmation: ${status.held.join(', ')}`];
  if (shown.length === 0 || shown.some((r) => r.stale)) return ['bad', `Not confirmed, ${last}`];
  if (shown.some((r) => r.source === 'boi-sdmx')) return ['warn', `Working through SDMX, ${last}`];
  return ['good', `Working, ${last}`];
}

const STORAGE: Record<Status['storage'], [Level, string]> = {
  ok: ['good', 'Working'],
  unknown: ['warn', 'Not checked yet'],
  disabled: ['warn', 'Not configured: rates are lost on restart'],
  error: ['bad', 'Failing: new rates are kept in memory'],
};

export function StatusPanel({ shown, status }: { shown: Rate[]; status: Status }) {
  const lines: [string, [Level, string]][] = [
    ['Bank of Israel', boiState(shown, status)],
    ['Backup (ECB)', status.backupReady ? ['good', 'Ready'] : ['bad', 'No recent rate']],
    ['Database', STORAGE[status.storage]],
  ];
  return (
    <section className="status" aria-labelledby="status-title">
      <h2 id="status-title">System status</h2>
      <dl>
        {lines.map(([name, [level, text]]) => (
          <div key={name}>
            <dt>
              <span className={`dot ${level}`} aria-hidden="true" />
              {name}
            </dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
      <p className="note">Times are in Israel time.</p>
    </section>
  );
}
