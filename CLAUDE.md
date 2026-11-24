# Project context — BOI Exchange Rates (home assignment)

## The assignment (from the interviewer, verbatim)
יש לפתח API לקבלת שערי המט"ח העדכניים מבנק ישראל.
ה-API ישמש תהליך פיננסי קריטי במערכת.
יש לתמוך לפחות ב-USD, EUR ו-GBP.
את הפתרון יש להעלות ל-GitHub ולצרף README עם הוראות הרצה.
שאר ההחלטות הטכנולוגיות והמימושיות הן לשיקולך.
מותר להשתמש ב-AI, רק תדרש להסביר מה יש בקוד.

Key point: "critical financial process" — reliability and correctness are what's being graded, more than UI polish.

## Stack
- Monorepo: `server/` (Node + TypeScript, Express or Fastify) and `client/` (React + Vite + TypeScript)
- Tests: vitest. Validation: zod. Docs: Swagger/OpenAPI.
- Dockerfile per app + docker-compose for local run.
- Later: deploy (API on Render/Railway/Fly.io, UI on Vercel).

## Data source
- `https://boi.org.il/PublicApi/GetExchangeRates` — JSON, `exchangeRates` array.
  Each item: `key` (currency code), `currentExchangeRate` (ILS per `unit`), `unit` (1/10/100), `currentChange` (% vs previous), `lastUpdate`.
- Its `date` param is ignored — always returns the latest rates.
- Historical rates (if needed): BOI SDMX series at `edge.boi.gov.il`.
- Verify the actual response shape against the live endpoint before relying on it.

## Reliability requirements
- Normalize by `unit`; use decimal-safe handling, never float math for money.
- Timeout + retry with exponential backoff on the upstream call.
- Validate the upstream response (zod); reject malformed data.
- In-memory cache; if BOI is unavailable, serve last known rates with `stale: true` and their date.
- Weekends/holidays: return last published rate with its date.
- Clear errors: 404 unsupported currency, 503 no data at all.
- Endpoints: `GET /api/rates`, `GET /api/rates/:currency`, `GET /health`.
- Structured logs. Unit + integration tests with BOI mocked.

## UI
One clean screen: USD/EUR/GBP rates, last-update date, stale-data indicator, amount converter.

## How to work with me
- Work in stages: server + tests → UI → Docker + README → deploy.
- After each stage: stop, explain what was written and why (I must be able to explain all the code in the interview), then commit.
- README should include run instructions and a short "design decisions" section.
