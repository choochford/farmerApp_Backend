# GrowGuide backend

Node/Express implementation of [backend-api-spec.md](./API-SPEC.md),
running against [schema.sql](./schema.sql).

## Setup

```bash
npm install
cp .env.example .env   # fill in real values — see below
npm run dev             # tsx watch, hot reload
```

Requires Postgres 14+ and Redis running locally (or update `DATABASE_URL` /
`REDIS_URL` to point elsewhere). Load the schema before starting:

```bash
psql "$DATABASE_URL" -f ./schema.sql
```

## What's real vs. stubbed

**Fully implemented:**
- JWT auth (Apple/Google/anonymous sign-in, access + refresh tokens)
- Crops, schedule, soil, region, weather routes
- The date-math scheduling engine (`services/dateMathEngine.ts`)
- Claude streaming proxy with server-assembled system prompt and a
  two-layer usage limiter (Redis burst guard + Postgres monthly budget)
- Apple/Google receipt verification calling the real verification endpoints
- Rate limiting, error handling, the nightly reminder sweep query

**Stubbed — needs real credentials/infra before this runs end-to-end:**
- `zone_lookup` and `soil_regional_defaults` tables exist in the schema but
  need to be populated by a one-time USDA-data ingestion job (not written
  here — see the comment in `routes/region.ts`)
- Apple/Google sign-in token verification decodes but doesn't fully verify
  signatures yet (`routes/auth.ts` — flagged inline)
- Webhook signature verification for refund notifications (`routes/purchases.ts`)
- Actual push notification delivery (`jobs/reminderJob.ts` finds due
  reminders and logs them; wiring in `firebase-admin` is the remaining step)

## Known limitations worth reading before you build on this

- **`reminder_sent` is lost on every schedule recalculation.** `dateMathEngine.ts`
  deletes and reinserts a user_crop's schedule rows whenever it recalculates
  (e.g. after a frost-date shift), which resets `reminder_sent` to false even
  for dates that already passed and were already notified on. Worth a diff-based
  update instead of delete+reinsert before this goes to production — flagged
  in the code comment but not fixed, since it requires a product decision
  about whether to suppress re-notifying or not.
- **Single-region assumption.** Schema supports multiple regions per user, but
  the date-math engine and AI system prompt both only ever query the one row
  where `is_primary = true`. Multi-plot support (mentioned as a "nice to have"
  in the PRD) isn't threaded through here yet.
- **No automated tests.** `vitest` is in package.json but nothing's written
  yet — the date-math engine in particular has enough date-arithmetic edge
  cases (timezone handling, leap years) that it deserves a real test suite
  before launch.

## Running migrations

There's no migration framework wired up — `schema.sql` is meant to be
applied once to an empty database. If you need to evolve the schema after
data exists, you'll want to introduce something like `node-pg-migrate` or
`Prisma Migrate` rather than hand-editing `schema.sql` going forward.
