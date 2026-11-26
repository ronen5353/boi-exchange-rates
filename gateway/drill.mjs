// Breaks instances under steady traffic and counts what a customer would notice.
// From the project folder, with Docker Compose running: node gateway/drill.mjs
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const compose = (...args) => run('docker', ['compose', ...args]);
const URL = 'http://localhost:3000/api/convert?from=ILS&to=USD&amount=1000';
const REQUESTS_PER_SECOND = 20;

async function request() {
  const start = performance.now();
  let outcome;
  try {
    const response = await fetch(URL, { signal: AbortSignal.timeout(10_000) });
    const body = await response.json();
    outcome = response.ok && body.result ? 'ok' : String(response.status);
  } catch (err) {
    outcome = err.name;
  }
  return { outcome, ms: performance.now() - start };
}

async function waitUntilAllReady() {
  for (let i = 0; i < 60; i++) {
    const { stdout } = await compose('exec', '-T', 'gateway', 'wget', '-qO-', 'http://127.0.0.1:8405/metrics');
    const up = stdout.match(/^haproxy_server_check_status\{proxy="ready",server="server\d",state="L7OK"\} 1$/gm) ?? [];
    if (up.length === 2) return;
    await sleep(1_000);
  }
  throw new Error('The instances did not become ready');
}

async function drill(name, action, recover) {
  await waitUntilAllReady();
  const pending = [];
  const timer = setInterval(() => pending.push(request()), 1_000 / REQUESTS_PER_SECOND);
  try {
    await sleep(2_000);
    await action();
    await sleep(6_000);
  } finally {
    await recover();
  }
  await waitUntilAllReady();
  clearInterval(timer);
  const results = await Promise.all(pending);
  const failed = results.filter((r) => r.outcome !== 'ok');
  console.log(
    `${name}: ${results.length} requests, ${failed.length} failed, slowest ${Math.round(Math.max(...results.map((r) => r.ms)))} ms`,
    failed.length > 0 ? [...new Set(failed.map((r) => r.outcome))] : '',
  );
}

const start = (...servers) => () => compose('start', ...servers);
await drill('Restart of the working instance (deployment)', () => compose('stop', 'server1'), start('server1'));
await drill('Crash of the working instance', () => compose('kill', 'server1'), start('server1'));
await drill('Hang of the working instance', () => compose('pause', 'server1'), () => compose('unpause', 'server1'));
await drill('Loss of the standby', () => compose('kill', 'server2'), start('server2'));
await drill('Loss of the database', () => compose('kill', 'db'), start('db'));
await drill('Loss of both instances (failures expected)', () => compose('kill', 'server1', 'server2'), start('server1', 'server2'));

// Last, because afterwards this computer is limited for 10 seconds.
const flood = [];
for (let i = 0; i < 800; i++) flood.push(request());
const limited = (await Promise.all(flood)).filter((r) => r.outcome === '429').length;
console.log(`Flood: 800 requests at once, ${limited} got 429`);
