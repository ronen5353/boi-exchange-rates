# BOI Exchange Rates

An API that serves the latest exchange rates published by the Bank of Israel (BOI), with a small UI.
It is built for use by a critical financial process, so the focus is on correctness and on predictable
behavior when BOI is slow, unavailable or returns bad data.

- `server/` – Node.js, TypeScript, Fastify
- `client/` – React, Vite, TypeScript

## Run with Docker

Requires Docker with Compose.

```
docker compose up --build
```

- UI: http://localhost:8080
- API: http://localhost:3000/api/rates
- API docs (Swagger): http://localhost:3000/docs

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

BOI is always mocked, so the tests need no network access.

## API

| Endpoint | Description |
|---|---|
| `GET /api/rates` | All rates |
| `GET /api/rates/:currency` | One rate, e.g. `/api/rates/USD` (case-insensitive) |
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
  "stale": false
}
```

- `rate` – ILS per **one** unit of the currency. Use this one for calculations.
- `officialRate`, `unit` – as published: 2.1026 ILS per 100 JPY.
- `rateDate` – publication date in Israel.
- `source` – `boi`, or `boi-sdmx` for the fallback, where `changePercent` and `lastUpdate` are `null`.
- `stale` – the latest refresh could not renew this rate, so it is the last known one.

Errors have the form `{ "error": { "code", "message" } }`:

| Status | Code | Meaning |
|---|---|---|
| 404 | `UNSUPPORTED_CURRENCY` | Currency not supported |
| 404 | `NOT_FOUND` | No such route |
| 503 | `NO_DATA` | No rates at all |
| 503 | `RATE_UNAVAILABLE` | Supported currency, but no rate for it right now |

Supported: USD, EUR, GBP, JPY, AUD, CAD, DKK, NOK, ZAR, SEK, CHF, JOD, LBP, EGP.

## Configuration

Environment variables of the server, all optional. Invalid values stop it from starting.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | |
| `HOST` | `0.0.0.0` | |
| `LOG_LEVEL` | `info` | |
| `CACHE_TTL_MS` | `300000` | How long rates are considered fresh |
| `RETRY_INTERVAL_MS` | `30000` | Wait after a failure or after using the fallback |
| `UPSTREAM_TIMEOUT_MS` | `3000` | Timeout of one attempt |
| `UPSTREAM_ATTEMPTS` | `3` | Attempts per source |
| `UPSTREAM_BACKOFF_MS` | `200` | Base of the exponential backoff |
| `BOI_URL`, `SDMX_URL` | BOI addresses | Upstream sources |

## Design decisions

**Two sources.** Rates come from BOI's public API. If it fails, USD, EUR and GBP come from BOI's SDMX API.
If that fails too, the last known rates are served with `stale: true`; with none, the response is 503.

**No float math.** JSON numbers are read as their original text, calculated with `decimal.js` and returned
as strings. The converter in the UI works the same way and rounds only the final result.

**Strict validation.** A response that is malformed, or lacks a valid USD, EUR or GBP, is rejected as a whole.
An invalid minor currency is dropped on its own, so that it can't take USD down. Nothing reaches the cache
before validation, and a rate is never replaced by one from an earlier date.

**Retry only what can recover.** Network errors, timeouts, 429 and 5xx are retried with exponential backoff and
jitter. Other 4xx and invalid data are not, including an HTML page returned with status 200.

**Refresh on demand.** A request refreshes the rates if they are over 5 minutes old; concurrent requests share
one call to BOI. Rates change about once per business day, so a background timer would add little.

**Stale is not the same as old.** On weekends and holidays the latest published rate is still valid, so it is not
stale; `rateDate` shows its date. Staleness is per currency because the fallback covers only three.

**Health is about the process.** `/health` returns 200 during a BOI outage, with the data status in its body.
Restarting wouldn't fix BOI, and would lose the cache.

## Limitations and next steps

- The cache is in memory: it is lost on restart and not shared between instances. Redis would solve both.
- There is no maximum age for stale rates. Consumers decide using `stale`, `rateDate` and `fetchedAt`.
- If both sources hang, one request can wait about 19 seconds. Under constant traffic, a background refresh would
  avoid that.
- Both sources belong to BOI, so one failure could affect both.
- No authentication or rate limiting.
