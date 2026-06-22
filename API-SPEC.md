# GrowGuide Backend API Specification
**Status:** Draft v1 · **Owner:** Todd Ford · **Last updated:** June 18, 2026

---

## 1. Architecture Overview

```
Mobile App (React Native)
        │
        ▼
   API Gateway / Load Balancer
        │
        ▼
   Application Server (Node.js/Express or similar)
        │
   ┌────┼────────────────┬─────────────────┬──────────────────┐
   ▼    ▼                ▼                 ▼                  ▼
Postgres  Redis      Claude API        Weather API        Push Service
(primary) (cache/    (proxied,         (NOAA/OpenWeather)  (FCM + APNs)
          rate limit)  key server-side)
   │
   ▼
USDA Zone Data (ingested at build time, served from Postgres — no live external call needed per-request)
```

**Recommended stack:** Node.js (Express or Fastify) or a managed BaaS (Supabase/Firebase) for faster MVP delivery — either works with the schema below. Postgres for relational data (users, crops, schedules), Redis for session/rate-limit/cache. All third-party API keys (Claude, weather, ad network server-side verification) live only on the server — never shipped in the mobile binary.

**Why a backend is required, not optional:** the AI assistant feature calls the Anthropic API with a key that cannot be embedded in the client app (it would be extractable from the binary). In-app purchase receipts must be validated server-side against Apple/Google, since client-reported purchase status is not trustworthy. Both of these alone necessitate a backend even though much of the rest of the app could theoretically run client-only.

---

## 2. Data Models

### User
| Field | Type | Notes |
|---|---|---|
| id | uuid | primary key |
| email | string | unique, nullable if anonymous |
| auth_provider | enum | `apple`, `google`, `email`, `anonymous` |
| created_at | timestamp | |
| ad_free | boolean | default false |
| ad_free_purchase_id | uuid | nullable, FK to Purchase |
| push_token | string | nullable, FCM/APNs token |
| notification_prefs | jsonb | `{push: bool, frost_alerts: bool, watering: bool}` |

### Region
| Field | Type | Notes |
|---|---|---|
| user_id | uuid | FK to User |
| zip_or_postal | string | |
| latitude | float | |
| longitude | float | |
| hardiness_zone | string | e.g. `"7a"` |
| last_frost_date | date | average, recalculated yearly |
| first_frost_date | date | average, recalculated yearly |
| microclimate_offset | int | user-entered zone adjustment, default 0 |

### Crop (reference table, not user-specific)
| Field | Type | Notes |
|---|---|---|
| id | string | slug, e.g. `tomato` |
| name | string | |
| emoji | string | for UI |
| days_to_maturity | int | |
| start_method | enum | `seed`, `transplant` |
| zone_range | string | e.g. `"6-10"` |
| companions | string[] | |
| soil_ph_min | float | |
| soil_ph_max | float | |

### UserCrop
| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| user_id | uuid | FK |
| crop_id | string | FK to Crop |
| bed_id | uuid | nullable, FK to Bed (phase 2) |
| planted_date | date | nullable |
| status | enum | `planned`, `started_indoors`, `transplanted`, `harvested` |

### SoilProfile
| Field | Type | Notes |
|---|---|---|
| user_id | uuid | FK |
| ph | float | nullable until user enters or regional default applied |
| nitrogen_pct | float | nullable |
| phosphorus_pct | float | nullable |
| potassium_pct | float | nullable |
| source | enum | `regional_default`, `user_test` |
| updated_at | timestamp | |

### ScheduleItem
| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| user_crop_id | uuid | FK |
| title | string | e.g. "Start seeds indoors" |
| target_date | date | computed from frost dates + days_to_maturity |
| status | enum | `past`, `soon`, `future`, `done` |
| reminder_sent | boolean | |

### Purchase
| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| user_id | uuid | FK |
| platform | enum | `apple`, `google` |
| product_id | string | e.g. `growguide_remove_ads` |
| transaction_id | string | platform-issued, unique |
| receipt_data | text | raw receipt for audit/re-verification |
| verified_at | timestamp | |
| status | enum | `valid`, `refunded`, `revoked` |

### AIConversation / AIMessage
| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| user_id | uuid | FK |
| created_at | timestamp | |
| messages | jsonb | array of `{role, content, timestamp}` — capped/trimmed, see §7 |
| token_count_month | int | for usage-limit enforcement, reset monthly |

### ZoneLookup (reference, ingested — not user data)
| Field | Type | Notes |
|---|---|---|
| zip_or_postal | string | unique |
| latitude / longitude | float | for the lat/lng lookup path |
| hardiness_zone | string | |
| last_frost_date / first_frost_date | date | regional average |
| region_name | string | |

### SoilRegionalDefaults (reference, ingested — not user data)
| Field | Type | Notes |
|---|---|---|
| zip_or_postal | string | unique |
| ph, nitrogen_pct, phosphorus_pct, potassium_pct | float | baseline values shown before a user enters their own soil test |
| description | text | e.g. "clay-heavy, slightly alkaline" |

---

## 3. Authentication

`POST /v1/auth/apple` — body: `{identity_token}` → verifies with Apple, creates/returns user + session JWT
`POST /v1/auth/google` — body: `{id_token}` → verifies with Google, creates/returns user + session JWT
`POST /v1/auth/anonymous` — creates a device-bound anonymous user (no email), upgradeable later
`POST /v1/auth/refresh` — body: `{refresh_token}` → new access token
`POST /v1/auth/logout` — invalidates refresh token

All authenticated endpoints below expect `Authorization: Bearer <access_token>`.

---

## 4. Region & Climate

`GET /v1/region?zip=75457` or `GET /v1/region?lat=33.2&lng=-95.2`
Returns:
```json
{
  "hardiness_zone": "7a",
  "last_frost_date": "2026-03-15",
  "first_frost_date": "2026-11-15",
  "region_name": "Mount Vernon, TX"
}
```
Backed by a pre-ingested USDA zone dataset keyed by lat/lng grid cell — no external API call needed per request, so this endpoint should be fast and cacheable.

`POST /v1/users/me/region` — body: `{zip_or_postal, latitude, longitude, microclimate_offset}` → saves the user's region, including manual zone overrides.

---

## 5. Crops

`GET /v1/crops` — returns the full reference crop list (cacheable, changes rarely)
`GET /v1/crops/:id` — single crop detail
`GET /v1/users/me/crops` — the user's tracked crops with status
`POST /v1/users/me/crops` — body: `{crop_id, planted_date?}` → adds a tracked crop, triggers schedule generation (§6)
`PATCH /v1/users/me/crops/:id` — update status/planted_date
`DELETE /v1/users/me/crops/:id` — remove tracked crop

---

## 6. Schedule & Reminders

`GET /v1/users/me/schedule` — returns all upcoming/past schedule items across tracked crops, sorted by date
`POST /v1/users/me/schedule/recalculate` — re-runs the date-math engine (frost dates + days_to_maturity + start_method → target dates); called automatically when region or crops change

**Date-math engine logic (server-side, not client):**
- Seed-start crops: `start_indoors_date = last_frost_date - (weeks_before_transplant)`, `transplant_date = last_frost_date + buffer`
- Direct-sow crops: `sow_date = last_frost_date + buffer` (buffer varies by frost tolerance, stored per-crop)
- Harvest estimate: `target_date + days_to_maturity`
- Recalculates nightly via scheduled job if weather data shows a frost-date shift (e.g., unseasonably late cold front)

Push notifications are triggered by a scheduled job (cron or queue-based) that scans `ScheduleItem` rows daily and sends via FCM/APNs when `target_date` is within the user's configured lead time.

---

## 7. AI Assistant (Claude Proxy)

`POST /v1/ai/chat`
Body:
```json
{
  "conversation_id": "uuid or null for new",
  "message": "What should I do in my garden today?"
}
```
Server-side behavior:
1. Authenticate user, check `token_count_month` against plan limit (e.g., free tier: 20 messages/month; ad-free purchasers: higher limit or unlimited — open business decision)
2. Load user's Region, UserCrop, and SoilProfile rows; assemble system prompt server-side (never trust a client-supplied system prompt)
3. Call Anthropic API with the user's message appended to conversation history, streaming response back to client via SSE or chunked response
4. Persist the exchange to `AIConversation.messages`, increment `token_count_month`

Response: streamed text chunks, same shape as the Anthropic streaming API, so the client can reuse existing parsing logic.

`GET /v1/ai/conversations/:id` — fetch history
`DELETE /v1/ai/conversations/:id` — clear history

**Rate limiting:** enforce per-user limits in Redis (sliding window) in addition to the monthly token count, to prevent burst abuse.

---

## 8. Weather

`GET /v1/weather?lat=33.2&lng=-95.2` — proxies NOAA/OpenWeather, returns normalized forecast:
```json
{
  "current": {"temp_f": 68, "condition": "partly_cloudy", "humidity_pct": 48},
  "forecast": [{"date":"2026-06-19","high_f":72,"low_f":58,"condition":"rain","precip_in":0.4}],
  "frost_risk_tonight": false
}
```
Cached for ~30 minutes per location to stay within third-party API rate limits. `frost_risk_tonight` drives the dashboard frost alert and is also checked by the nightly reminder job to push proactive frost warnings tied to the user's actual tracked crops.

---

## 9. Soil

`GET /v1/users/me/soil` — returns current profile (regional default or user-entered)
`PUT /v1/users/me/soil` — body: `{ph, nitrogen_pct, phosphorus_pct, potassium_pct}` → sets `source: user_test`
`GET /v1/soil/regional-defaults?zip=75457` — returns baseline soil characteristics for the region when no user test data exists

---

## 10. In-App Purchases (Remove Ads)

`POST /v1/purchases/verify`
Body:
```json
{"platform": "apple", "receipt_data": "base64...", "product_id": "growguide_remove_ads"}
```
Server-side behavior:
1. Send receipt to Apple's `verifyReceipt` endpoint (or Google Play Developer API for Android) — never trust client-side "purchase successful" signals alone
2. On valid response, upsert a `Purchase` row and set `User.ad_free = true`
3. Return updated user object so the client can immediately hide ads

`POST /v1/purchases/restore` — body: `{platform, receipt_data}` → re-verifies and restores entitlement on a new device, same verification path as above
`POST /v1/webhooks/apple` and `/v1/webhooks/google` — handle server-to-server notifications (refunds, chargebacks) so `ad_free` can be revoked if a purchase is reversed

---

## 11. Advertising

The ad SDK (e.g., Google AdMob) runs client-side and talks directly to the ad network — no backend endpoint needed for serving ads themselves. The backend's only responsibility is the source of truth for `User.ad_free`, which the client checks on launch (`GET /v1/users/me`) to decide whether to initialize the ad SDK at all that session.

---

## 12. Error Response Format

All errors return a consistent shape:
```json
{"error": {"code": "INVALID_RECEIPT", "message": "Receipt could not be verified", "status": 400}}
```
Standard codes: `UNAUTHORIZED`, `RATE_LIMITED`, `INVALID_RECEIPT`, `AI_LIMIT_EXCEEDED`, `REGION_NOT_FOUND`, `VALIDATION_ERROR`.

---

## 13. Security Notes

- All API keys (Anthropic, weather provider) stored in a secrets manager (AWS Secrets Manager, given existing AWS familiarity), never in client code or environment files committed to source control
- JWT access tokens short-lived (15 min), refresh tokens longer-lived and revocable
- Receipt verification always server-to-server, never client-reported
- Rate limit `/v1/ai/chat` and `/v1/auth/*` aggressively to control cost and prevent abuse
- HTTPS only; certificate pinning recommended for the mobile client given financial (IAP) data in transit

---

## 14. Open Questions

- Free-tier AI message limit per month — needs a number tied to expected Claude API cost per user
- Should anonymous (no-login) users be allowed to purchase ad-free, or is account creation required first to make restore-on-reinstall reliable?
- Hosting choice: traditional VPS/ECS vs. a managed BaaS (Supabase/Firebase) — affects how much of this spec is custom code vs. configuration
