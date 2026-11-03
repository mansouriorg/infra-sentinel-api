# Infra Sentinel API

NestJS 11 service behind the Infra Sentinel console.

| What      | Where                                |
| --------- | ------------------------------------ |
| REST API  | http://localhost:4000/api/v1         |
| Health    | http://localhost:4000/api/v1/health  |
| Swagger   | http://localhost:4000/docs           |
| Mail inbox (dev) | http://localhost:8025         |

    bash ../scripts/db-up.sh   # PostgreSQL + Mailpit, first time and after reboots
    cp .env.example .env       # first time only
    pnpm start:dev             # watch mode, migrations run on boot
    pnpm test                  # unit tests
    pnpm test:e2e              # end-to-end tests (uses the infra_sentinel_test database)

## Configuration

Validated at boot by `src/config/env.ts`. Real environment variables win over `.env`.

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `DATABASE_URL` | local `infra_sentinel` database | PostgreSQL connection string |
| `MIGRATE_ON_BOOT` | `true` | Apply pending SQL migrations when the API starts |
| `WEB_URL` | `http://localhost:3000` | Used in email links and CORS |
| `SESSION_TTL_DAYS` | `30` | How long a sign-in lasts |
| `COOKIE_SECURE` | `false` | Set `true` when serving over HTTPS |
| `TRUST_PROXY` | `0` | Number of reverse proxies in front of the API |
| `SMTP_*`, `MAIL_FROM` | Mailpit on `localhost:1025` | Outgoing email |
| `SCHEDULER_ENABLED` | `true` | Run checks from this process. Set `false` for an API-only instance |
| `SCHEDULER_CONCURRENCY` | `20` | Checks running at the same time (1 to 200) |
| `RESULT_RETENTION_DAYS` | `30` | How long raw check results are kept. Hourly rollups and events are kept 400 days |
| `BLOCK_PRIVATE_TARGETS` | `false` | Refuse monitors that resolve to private, loopback or link-local addresses. Use `true` on shared hosts |

## Accounts and teams

- Sessions are opaque random tokens, stored hashed in PostgreSQL, sent as an HttpOnly cookie or `Authorization: Bearer`.
- Passwords use scrypt. Reset and confirmation links are single use and stored hashed.
- Every route needs a session unless it is marked `@Public()`. Roles (`viewer < member < admin < owner`) are enforced with `@MinRole()`.
- SQL migrations live in `src/database/migrations.ts`. Add a new entry to change the schema.

## Monitoring

- Monitors: `GET/POST /monitors`, `GET/PATCH/DELETE /monitors/:id`, `GET /monitors/:id/series?range=24h|7d|30d`, `POST /monitors/:id/pause|resume|check`, `POST /monitors/test`
- Dashboard data: `GET /overview`, `GET /events`. Live updates: `GET /stream` (server-sent events, scoped to the signed-in workspace)
- Roles: viewers read, members create and change monitors, admins delete them
- The scheduler ticks every second and claims due monitors from PostgreSQL with `FOR UPDATE SKIP LOCKED`, so several API instances can run side by side
- A monitor goes down only after `failureThreshold` failed checks in a row, with quick retries in between
- Request headers saved on a monitor are shown as `********` in API responses and kept as stored when you edit the monitor

### Heartbeat monitors

Create a heartbeat monitor and call the address shown on its page from your job:

    curl -fsS http://localhost:4000/api/v1/heartbeat/<token>        # job ran
    curl -fsS http://localhost:4000/api/v1/heartbeat/<token>/fail   # job failed

If no check-in arrives within the interval plus the grace period, the monitor goes down. The address is a secret: anyone who has it
can report the job as healthy.

## Alerts and incidents

- Channels: `GET/POST /channels`, `PATCH/DELETE /channels/:id`, `POST /channels/test` (saved or unsaved, 10 per minute). Types: email, slack, discord, telegram, ntfy, gotify, webhook
- Rules: `GET/POST /alert-rules`, `PATCH/DELETE /alert-rules/:id`. Policies: `/escalation-policies`. Schedules: `/oncall-schedules`
- Silences: `GET/POST /silences`, `DELETE /silences/:id`. Maintenance: `/maintenance-windows` (`GET`, `POST`, `PATCH`, `DELETE`)
- Incidents: `GET /incidents?status=active|open|acknowledged|resolved|all&monitorId=&limit=`, `GET /incidents/summary`, `GET /incidents/:id`,
  `POST /incidents/:id/acknowledge|resolve|assign|notes`, `PUT /incidents/:id/postmortem`
- Roles: viewers read everything. Members acknowledge, resolve, assign, add notes and postmortems, and manage silences and maintenance windows. Admins manage channels, rules, policies and schedules
- Channel secrets (webhook URLs, bot tokens, topics, signing secrets, header values) are shown as `********` and kept as stored when you edit the channel
- The alert engine runs inside the API when `SCHEDULER_ENABLED=true`. Every two seconds it opens incidents for monitors that are down (or slow, when a rule asks for it), closes the ones that recovered, and sends due notifications from a PostgreSQL queue (`FOR UPDATE SKIP LOCKED`, 3 attempts with 30 second and 2 minute backoff)
- A monitor with no matching rule still opens a critical incident. Silences and maintenance windows hold notifications back (maintenance also holds the incident back)
- Acknowledging an incident cancels notifications and escalation steps that are not sent yet. Resolving sends a recovery message to everyone who was alerted
- Webhook requests carry `X-Sentinel-Event` and, when a secret is set, `X-Sentinel-Signature: sha256=<hmac of the body>`. Webhook, Slack, Discord, ntfy, Gotify and Telegram targets follow `BLOCK_PRIVATE_TARGETS` like monitors do
