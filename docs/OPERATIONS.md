# Operations

How the exchange rates service is expected to behave in production, what can go wrong, and what people do about it.

## The process it serves

A customer deposits ILS. Before the money is sent to the trading platform it is converted to USD, so a missing rate
stops the deposit and a wrong rate loses money for the customer or for us. A conversion that already happened is hard
to undo, so **a wrong rate is worse than no rate**: when the service can't trust a rate it refuses, and the deposit
waits.

## Assumptions

These need the approval of Finance, Risk and Compliance. They are configuration, not code.

| # | Assumption | Setting |
|---|---|---|
| 1 | The rate is BOI's representative rate, without a spread or fees, which the deposit system adds | |
| 2 | A BOI rate may be used for 24 hours after BOI last confirmed it | `RATE_MAX_AGE_MS` |
| 3 | When no BOI rate is usable, a rate derived from the European Central Bank is acceptable for USD, EUR and GBP, if it is at most 4 days old. A deposit that must use a BOI rate asks with `officialOnly=true` | `BACKUP_MAX_AGE_DAYS` |
| 4 | A change of more than 5% between publications is unusual and needs a second source to confirm it, within 2% | `MAX_CHANGE_PERCENT`, `CONFIRM_TOLERANCE_PERCENT` |
| 5 | If nothing usable is left, the service blocks the currency and alerts people. It never guesses | |
| 6 | The service only calculates. It doesn't move money, hold a rate for later, or know about customers | |
| 7 | The deposit system calls it from inside the network, and stores the `conversionId` and the rate it received | |

## Service levels

Proposed targets, to be agreed with the business:

| What | Target |
|---|---|
| A usable USD rate, measured by `/ready` and `boi_ready` | 99.9% of the time, which is about 43 minutes a month |
| Response time of `/api/convert` | 95% under 0.5 seconds |
| Time to switch to the standby instance | Under 1 second, no failed requests (see Drills) |
| Rates lost in a restart | None: they are in PostgreSQL |
| Time from a problem to an alert | Immediately for critical, 1 minute for warnings |

The 99.9% depends mostly on BOI and on the other sources, not on us. Most of the outages that remain are BOI outages
longer than 24 hours combined with an ECB outage, or an unusual change that nobody can confirm.

## How a rate is chosen

| Layer | Source | Status | When |
|---|---|---|---|
| 1 | BOI public API | `fresh` | Normally |
| 2 | BOI SDMX API | `fresh` | Layer 1 fails |
| 3 | The last BOI rate | `stale` | Both BOI sources fail, for up to 24 hours after BOI last confirmed it |
| 4 | ECB cross rate, e.g. USD = (ILS per EUR) / (USD per EUR) | `backup` | No usable BOI rate |
| 5 | Manual rate, approved by two people | – | Proposed, not built: see Manual procedures |
| 6 | No conversion: the deposit is kept in ILS | – | A business process, see Manual procedures |

Every answer says which layer it came from (`source`, `status`, `rateDate`), so the deposit system can decide by its
own rules.

## Failures

| Failure | How we know | What happens by itself | Customer impact | What people do |
|---|---|---|---|---|
| BOI API down | Logs, `boi_source_fetches_total` | SDMX is used | None | Nothing |
| Both BOI sources down, less than 24 hours | `BoiRateNotConfirmed` after 1 hour, stale warning | The last BOI rate is used | None; `status: stale` | Check BOI's site. Usually it is a holiday or a BOI outage |
| Both BOI sources down, more than 24 hours | Critical alert: ECB in use | ECB rates for USD, EUR, GBP; other currencies blocked | `status: backup`; `officialOnly` deposits wait | Decide with Finance whether to continue on ECB or to stop |
| Everything down | Critical alert, `CannotConvert` | 503 `RATE_EXPIRED` | Deposits can't convert | Layer 6. Consider layer 5 |
| BOI publishes a suspicious rate | Critical alert: currency held | Checked against SDMX and ECB; used only if confirmed, otherwise the currency is blocked | That currency waits, others work | See "A held currency" |
| BOI returns invalid data | Logs: rejected | Whole response rejected; next layer | None | If it lasts, report it to BOI |
| Working instance crashes or hangs | Gateway logs, `ServerDown` | The gateway switches to the standby within a second and retries | None | Find the cause in the logs. It restarts by itself after a crash |
| Both instances down | `AllServersDown` | 503 `SERVICE_UNAVAILABLE` from the gateway | Deposits can't convert | Restart; layer 6 meanwhile |
| Gateway down | `GatewayDown` | – | Nothing reaches the API | Restart it. In production, a managed load balancer |
| Database down | Warning: database failing | Works from memory, saves later | None | Fix the database. A restart while it is down starts without rates |
| A caller floods the API | 429s in the gateway logs | That address gets 429 | Only that caller | Find the caller. Raise its limit if it is the deposit system |
| Wrong configuration | The server refuses to start | The old version keeps running | None | Fix the setting |
| Alerts can't be delivered | Logs: "Could not send an alert" | Retried every 10 seconds | None | Prometheus alerts still work |

## Alerts

| Alert | From | Severity | First step |
|---|---|---|---|
| `USD can't be converted (expired)` | Server | Critical | Check BOI, SDMX and ECB in the logs. Start layer 6 |
| `USD changed unusually` | Server | Critical | See "A held currency" |
| `ECB rates instead of BOI rates` | Server | Critical | Tell Finance. Confirm that the BOI outage is real |
| `Some rates could not be renewed` | Server | Warning | Usually nothing |
| `No usable ECB backup rate` | Server | Warning | Nothing urgent, but layer 4 is gone |
| `The database is failing` | Server | Warning | Fix it before the next deployment |
| `AllServersDown`, `GatewayDown` | Prometheus | Critical | Restart; check the host |
| `ServerDown` | Prometheus | Warning | There is no standby left; fix it today |
| `CannotConvert` | Prometheus | Critical | As for "can't be converted" |
| `BoiRateNotConfirmed` | Prometheus | Warning | Check BOI |
| `ServerErrors`, `SlowRequests` | Prometheus | Critical, warning | Logs of the failing requests, by `x-request-id` |

Every problem is announced once when it starts and once when it ends. Each instance announces its own, so the same
problem can arrive twice.

## Manual procedures

### A held currency

The service saw a change of more than 5% that no other source confirmed. Either the old or the new rate is wrong.

1. Compare the new rate with BOI's website and with a market source.
2. If the new rate is real, it is released automatically when SDMX or ECB confirms it, or when BOI repeats it in the
   next publication. Until then, deposits in that currency wait (layer 6).
3. If it is a BOI mistake, report it to BOI. The service keeps blocking it.

There is no button to release a rate by hand. That is layer 5.

### Layer 5: a manual rate (proposed)

For a long outage of every source. A person enters a rate with its source, for example a bank quote, and a second
person approves it. It is valid for a few hours, is marked `status: manual`, is logged with both names, and the
deposit system decides whether it accepts it. It is not built because it needs authentication, an approval flow and an
agreed policy, and because a wrong manual rate is the most likely way for this service to lose money.

### Layer 6: keep the deposit in ILS (business process)

When no rate can be used, the deposit is accepted in ILS and converted later. The customer is told, and the conversion
happens when a rate is available, at that rate, with the customer's consent where the terms require it. The money
is safe and nothing is guessed; the cost is a delay. This is the deposit system's decision, so the service only makes
it clear with a 503 and a reason (`RATE_EXPIRED`, `RATE_HELD`, `RATE_NOT_OFFICIAL`).

### Deploying

Restart the instances one at a time: `docker compose up -d --no-deps --build server2`, wait until the gateway shows it
as up, then the same for `server1`. A stopping instance is first taken out of the gateway and keeps answering for 3
seconds, so no request fails.

### Restoring after data loss

Rates come back from BOI within seconds of a start. The database is needed only to start during a BOI outage, and as
the history of the rates that were served. Conversions are recorded in the logs, so the logs must be kept as long as
the deposits they describe.

## How the deposit system should call it

- Use `GET /api/convert`, not the rate, so that the rounding is the same everywhere.
- Store the `conversionId` and the whole `rate` object with the deposit. It proves which rate was used.
- Send an `x-request-id`, such as the deposit ID. It appears in our logs.
- Use a timeout of a few seconds and retry on a network error, 502 or 504. A retry is safe because nothing is changed.
- Don't retry a 503 with a reason quickly: it is a decision, not a glitch. Use layer 6.
- Decide whether `status: stale` and `status: backup` are acceptable, and use `officialOnly=true` if not.

## Drills

`node gateway/drill.mjs` sends 20 conversions a second while it breaks parts of the system. Results on one computer:

| What breaks | Failed requests | Slowest |
|---|---|---|
| Restart of the working instance | 0 | 0.06 s |
| Crash of the working instance | 0 | 0.5 s |
| Hang of the working instance | 0 | 3 s |
| Loss of the standby | 0 | 0.03 s |
| Loss of the database | 0 | 0.04 s |
| Loss of both instances | Most, as expected | 2 s |

Source failures, unusual rates and alerts are covered by the automated tests (`server/test/policy.test.ts`,
`server/test/monitoring.test.ts`). A drill of the full flow, including a held rate and ECB, should be repeated in
production every few months.

## What production still needs

- Two zones, a managed load balancer and a replicated database. Here everything is on one computer.
- Alertmanager to deliver Prometheus alerts, and a webhook for the server alerts.
- Authentication between the deposit system and the service.
- Central collection of the logs, since they hold the record of conversions.
- Layer 5, if the business wants it.

## Open questions for the business

1. Is a non-BOI rate acceptable at all, and for which deposits?
2. Are 24 hours and 5% the right limits?
3. Should the rate be guaranteed between showing it to the customer and converting? That needs a quote with an expiry.
4. What may the customer be told when a deposit waits?
