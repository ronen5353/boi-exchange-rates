import { hostname } from 'node:os';
import { REQUIRED_CURRENCIES } from '../domain/rates.js';
import type { Logger, ServiceStatus } from '../rates/service.js';

type Severity = 'critical' | 'warning';

interface Problem {
  key: string;
  severity: Severity;
  message: string;
}

interface ActiveProblem extends Problem {
  since: number;
  /** Whether people were told about it. */
  announced: boolean;
}

export interface AlertsOptions {
  getStatus: () => ServiceStatus;
  /** Sends a message to people. Rejects if it could not be delivered. */
  send: (text: string) => Promise<void>;
  /** Warnings that end sooner than this are not announced. */
  warningDelayMs: number;
  checkIntervalMs: number;
  log: Logger;
  now?: () => number;
}

/** Critical: customers can't convert. Warning: they can, but something needs attention. */
export function findProblems(status: ServiceStatus): Problem[] {
  // Nothing is known before the first refresh.
  if (!status.initialized) return [];
  const problems: Problem[] = [];
  const add = (key: string, severity: Severity, message: string) => problems.push({ key, severity, message });

  for (const { currency, reason } of status.unavailable) {
    const required = (REQUIRED_CURRENCIES as readonly string[]).includes(currency);
    add(`unavailable:${currency}`, required ? 'critical' : 'warning', `${currency} can't be converted (${reason})`);
  }
  for (const currency of status.held) {
    add(`held:${currency}`, 'critical', `${currency} changed unusually and needs a person to check it`);
  }
  if (status.onBackup.length > 0) add('backup', 'critical', 'Some currencies use ECB rates instead of BOI rates');
  if (status.stale) add('stale', 'warning', 'Some rates could not be renewed from BOI');
  if (!status.backupReady) add('no-backup', 'warning', 'There is no usable ECB backup rate');
  if (status.storage === 'error') add('storage', 'warning', 'The database is failing, rates are kept in memory');
  return problems;
}

/** Announces each problem once when it starts and once when it ends. */
export class Alerts {
  private readonly options: AlertsOptions;
  private readonly now: () => number;
  private readonly active = new Map<string, ActiveProblem>();
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | null = null;

  constructor(options: AlertsOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  start(): void {
    this.timer = setInterval(() => void this.check(), this.options.checkIntervalMs);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.inFlight;
  }

  /** Never rejects, and never runs twice at the same time. */
  check(): Promise<void> {
    this.inFlight ??= this.runCheck().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async runCheck(): Promise<void> {
    const problems = new Map(findProblems(this.options.getStatus()).map((p) => [p.key, p]));

    for (const problem of problems.values()) {
      const known = this.active.get(problem.key);
      const entry = { since: this.now(), announced: false, ...known, ...problem };
      this.active.set(problem.key, entry);
      const due = problem.severity === 'critical' || this.now() - entry.since >= this.options.warningDelayMs;
      // If sending fails it stays unannounced, so the next check tries again.
      if (!entry.announced && due) entry.announced = await this.announce(problem.severity.toUpperCase(), problem);
    }
    for (const [key, entry] of this.active) {
      if (problems.has(key)) continue;
      if (!entry.announced || (await this.announce('RESOLVED', entry))) this.active.delete(key);
    }
  }

  private async announce(label: string, problem: Problem): Promise<boolean> {
    const { log, send } = this.options;
    // Logged too, so that nothing is lost if the message can't be delivered.
    log.warn({ alert: problem.key, label }, problem.message);
    try {
      await send(`[${label}] BOI rates (${hostname()}): ${problem.message}`);
      return true;
    } catch (err) {
      log.error({ alert: problem.key, err }, 'Could not send an alert');
      return false;
    }
  }
}

/** Works with Slack-compatible incoming webhooks. */
export function createWebhookSender(url: string, fetchFn: typeof fetch = fetch) {
  return async (text: string): Promise<void> => {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Webhook responded with HTTP ${response.status}`);
  };
}
