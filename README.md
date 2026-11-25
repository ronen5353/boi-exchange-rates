# BOI Exchange Rates

An API that serves the latest exchange rates published by the Bank of Israel (BOI), with a small UI.
It is built for use by a critical financial process, so the focus is on correctness and on predictable
behavior when BOI is slow, unavailable or returns bad data.

- `server/` – Node.js, TypeScript, Fastify
- `client/` – React, Vite, TypeScript

## Live demo

- UI: https://boi-exchange-rates.vercel.app
- API: https://boi-exchange-rates.onrender.com/api/rates
- API docs: https://boi-exchange-rates.onrender.com/docs

The API runs on a free plan that sleeps when idle, so the first request can take about a minute.
The UI on Vercel forwards `/api` to it (`client/vercel.json`).

## Run with Docker

Requires Docker with Compose.

```
docker compose up --build
```

- UI: http://localhost:8080
- API: http://localhost:3000/api/rates
- API docs (Swagger): http://localhost:3000/docs

With `docker compose --profile monitoring up --build`, Prometheus with alert rules is at http://localhost:9090.

## Run without Docker

Requires Node.js 22 or later (developed on 24). Use two terminals, starting from the project folder:

```
cd server
npm ci
npm run dev
```

```
cd client
npm ci
npm run dev
```

The UI is at http://localhost:5173 and the API at http://localhost:3000.

## Tests

In `server/` or `client/`, after `npm ci`:

```
npm test
```

BOI is always mocked, so the tests need no network access. The PostgreSQL tests are skipped unless
`TEST_DATABASE_URL` points to a disposable database (its `rates` table is dropped). CI runs them.

## API

| Endpoint | Description |
|---|---|
| `GET /api/rates` | All rates |
| `GET /api/rates/:currency` | One rate, e.g. `/api/rates/USD` (case-insensitive) |
| `GET /api/convert?from=ILS&to=USD&amount=1000` | Convert between ILS and another currency |
| `GET /api/status` | Data status, for the UI: what is served from where, and what is blocked |
| `GET /ready` | 200 if USD, EUR and GBP can be converted, otherwise 503 |
| `GET /metrics` | Prometheus metrics |
| `GET /health` | Process health and data status |

Example, `GET /api/rates/JPY`:

```json
{
  "base": "ILS",
  "currency": "JPY",
  "rate": "0.021026",
  "officialRate": "2.1026",
  "unit": 100,
  "changePercent": "0.5644",
  "rateDate": "2026-11-23",
  "lastUpdate": "2026-11-23T13:21:10.7104898Z",
  "source": "boi",
  "fetchedAt": "2026-11-24T07:55:39.488Z",
  "status": "fresh",
  "stale": false
}
```

- `rate` – ILS per **one** unit of the currency. Use this one for calculations.
- `officialRate`, `unit` – as published: 2.1026 ILS per 100 JPY.
- `rateDate` – publication date in Israel.
- `source` – `boi`, `boi-sdmx` or `ecb`. Except with `boi`, `changePercent` and `lastUpdate` are `null`.
- `status` – `fresh`; `stale`: the last known BOI rate, still within its time limit; `backup`: not a BOI rate.
- `stale` – true unless the status is `fresh`.

`/api/convert` returns `conversionId`, `result` and the full `rate` that was used, and logs all of them, so it is
possible to prove which rate a deposit used. It calculates only; it doesn't move money or guarantee the rate. With
`officialOnly=true` it refuses a rate that is not from BOI. Results are rounded half up.

Errors have the form `{ "error": { "code", "message" } }`:

| Status | Code | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST`, `UNSUPPORTED_PAIR`, `INVALID_AMOUNT`, `AMOUNT_TOO_SMALL` | Invalid request |
| 404 | `UNSUPPORTED_CURRENCY` | Currency not supported |
| 404 | `NOT_FOUND` | No such route |
| 503 | `NO_DATA` | No usable rates at all |
| 503 | `RATE_EXPIRED` | The last known rate is too old, and there is no usable backup |
| 503 | `RATE_HELD` | An unusual change is waiting for confirmation |
| 503 | `RATE_NOT_OFFICIAL` | Only a backup rate is available, and `officialOnly` was requested |
| 503 | `RATE_UNAVAILABLE` | Supported currency, but no rate for it right now |

Supported: USD, EUR, GBP, JPY, AUD, CAD, DKK, NOK, ZAR, SEK, CHF, JOD, LBP, EGP.

## Configuration

Environment variables of the server, all optional. Invalid values stop it from starting.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `LOG_LEVEL` | `info` | |
| `DATABASE_URL` | none | PostgreSQL. Without it, rates are kept in memory only |
| `CACHE_TTL_MS` | `300000` | Time between background refreshes |
| `RETRY_INTERVAL_MS` | `30000` | The same, after a failure or after using the fallback |
| `BACKUP_INTERVAL_MS` | `3600000` | Time between ECB refreshes |
| `RATE_MAX_AGE_MS` | `86400000` | How long a BOI rate may be used after its last confirmation |
| `BACKUP_MAX_AGE_DAYS` | `4` | Maximum age of an ECB rate |
| `MAX_CHANGE_PERCENT` | `5` | A larger change needs confirmation |
| `CONFIRM_TOLERANCE_PERCENT` | `2` | How close a confirming source must be |
| `ALERT_WEBHOOK_URL` | none | Slack-compatible webhook. Without it, alerts are only logged |
| `ALERT_WARNING_DELAY_MS` | `60000` | Shorter problems that don't stop conversions are not announced |
| `ALERT_CHECK_INTERVAL_MS` | `10000` | |
| `UPSTREAM_TIMEOUT_MS` | `3000` | Timeout of one attempt |
| `BACKUP_TIMEOUT_MS` | `10000` | The same, for ECB |
| `UPSTREAM_ATTEMPTS` | `3` | Attempts per source |
| `UPSTREAM_BACKOFF_MS` | `200` | Base of the exponential backoff |
| `BOI_URL`, `SDMX_URL`, `ECB_URL` | public addresses | Upstream sources |

## Design decisions

**Layers of sources.** A customer who can't convert can't buy, so each layer covers for the one before it:

1. BOI's public API.
2. BOI's SDMX API, for USD, EUR and GBP.
3. The last known BOI rate, for 24 hours after BOI last confirmed it (`stale`).
4. The European Central Bank, for USD, EUR and GBP (`backup`). It is independent of BOI, but not the BOI rate.
5. A clear 503. A wrong conversion can't easily be undone, so a rate that can't be trusted is not returned.

A recent BOI rate comes before ECB because BOI publishes about once per business day, so it is usually still the
official one.

**Unusual changes need confirmation.** A change of more than 5% is accepted only if SDMX or ECB agrees, or if BOI
repeats it in its next publication. If SDMX contradicts it, SDMX is used. SDMX belongs to BOI and can repeat its
mistake, so a BOI rate is also rejected if an ECB rate of the same date or later contradicts it, and ECB is used.
Otherwise that currency is blocked: either the old or the new rate may be wrong.

**No float math.** JSON numbers are read as their original text, calculated with `decimal.js` and returned
as strings. The converter in the UI works the same way and rounds only the final result.

**Strict validation.** A response that is malformed, or lacks a valid USD, EUR or GBP, is rejected as a whole.
An invalid minor currency is dropped on its own, so that it can't take USD down. Nothing reaches the cache
before validation, and a rate is never replaced by one from an earlier date.

**Retry only what can recover.** Network errors, timeouts, 429 and 5xx are retried with exponential backoff and
jitter. Other 4xx and invalid data are not, including an HTML page returned with status 200.

**Background refresh.** The server refreshes the rates every 5 minutes, or 30 seconds after a failure. Requests are
answered from memory, so a customer doesn't wait for a slow BOI; only requests that arrive during startup wait. If
refreshing itself stops, rates become stale by age.

**Rates survive a restart.** Rates are saved in PostgreSQL and restored on startup, marked stale until BOI confirms
them. The table keeps one row per published value with the times it was first seen and last confirmed, so it is
also the rate history. The database is optional at run time: if it is down, the API works from memory and
`/health` reports `storage: "error"`.

**No dates in the future.** A rate with a future date would block the correct ones until that date, so it is rejected.

**Stale is not the same as old.** On weekends and holidays the latest published rate is still valid, so it is not
stale; `rateDate` shows its date. Staleness is per currency because the fallback covers only three.

**Health is about the process.** `/health` returns 200 during a BOI outage, with the data status in its body.
Restarting wouldn't fix BOI, and would lose the cache.

**The team knows before the customer.** The server announces each problem once when it starts and once when it ends:
*critical* if a main currency can't be converted, a change is held or ECB is in use, and *warning* otherwise. A
server that is down can't report it, so Prometheus has its own rules (`monitoring/alerts.yml`). Every response has an
`x-request-id`, taken from the caller if it sends one, which also appears in the logs.

## Limitations and next steps

- The live demo has no database, so its rates are lost on restart.
- The time limits and percentages are assumptions that Risk and Finance would have to approve.
- After a holiday longer than 4 days, ECB can't be used until it publishes again.
- A held change is kept in memory only. After a restart the new rate is checked again from the start.
- If everything hangs during startup, the first requests can wait about 25 seconds.
- Only USD, EUR and GBP have a source other than BOI.
- Conversions are recorded in the logs, so the logs must be collected and kept.
- `/metrics` and `/docs` are not protected, so in production they should be reachable only from inside the network.
- Each instance sends its own alerts.
- The Prometheus rules are evaluated, but delivering them needs an Alertmanager.
- No authentication or rate limiting.
