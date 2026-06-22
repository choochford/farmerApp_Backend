-- ============================================================
-- GrowGuide — PostgreSQL schema v1
-- Generated June 18, 2026
-- Run against an empty database. Requires the uuid-ossp extension.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── ENUMS ────────────────────────────────────────────────────

CREATE TYPE auth_provider AS ENUM ('apple', 'google', 'email', 'anonymous');
CREATE TYPE crop_start_method AS ENUM ('seed', 'transplant');
CREATE TYPE user_crop_status AS ENUM ('planned', 'started_indoors', 'transplanted', 'harvested');
CREATE TYPE soil_source AS ENUM ('regional_default', 'user_test');
CREATE TYPE schedule_status AS ENUM ('past', 'soon', 'future', 'done');
CREATE TYPE purchase_platform AS ENUM ('apple', 'google');
CREATE TYPE purchase_status AS ENUM ('valid', 'refunded', 'revoked');
CREATE TYPE ai_message_role AS ENUM ('user', 'assistant');

-- ── USERS ────────────────────────────────────────────────────

CREATE TABLE users (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email                       VARCHAR(255) UNIQUE,
  auth_provider               auth_provider NOT NULL DEFAULT 'anonymous',
  auth_provider_id            VARCHAR(255),
  password_hash               VARCHAR(255),
  ad_free                     BOOLEAN NOT NULL DEFAULT false,
  ad_free_purchase_id         UUID,
  push_token                  VARCHAR(512),
  notification_push           BOOLEAN NOT NULL DEFAULT true,
  notification_frost_alerts   BOOLEAN NOT NULL DEFAULT true,
  notification_watering       BOOLEAN NOT NULL DEFAULT true,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_auth_provider_id ON users(auth_provider, auth_provider_id);

-- ── REGIONS (a user may eventually have more than one plot) ───

CREATE TABLE regions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label                 VARCHAR(100) NOT NULL DEFAULT 'Home garden',
  zip_or_postal         VARCHAR(20),
  latitude              DOUBLE PRECISION,
  longitude             DOUBLE PRECISION,
  hardiness_zone        VARCHAR(10),
  last_frost_date       DATE,
  first_frost_date      DATE,
  microclimate_offset   INTEGER NOT NULL DEFAULT 0,
  is_primary            BOOLEAN NOT NULL DEFAULT true,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_regions_user ON regions(user_id);

-- ── ZONE_LOOKUP (pre-ingested USDA hardiness zone + frost date data) ───
-- Populated by a separate one-time/yearly ingestion job (see
-- backend-api-spec.md §4) — not by application code at request time.

CREATE TABLE zone_lookup (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  zip_or_postal      VARCHAR(20) UNIQUE,
  latitude           DOUBLE PRECISION,
  longitude          DOUBLE PRECISION,
  hardiness_zone     VARCHAR(10) NOT NULL,
  last_frost_date    DATE NOT NULL,
  first_frost_date   DATE NOT NULL,
  region_name        VARCHAR(150)
);

CREATE INDEX idx_zone_lookup_latlng ON zone_lookup(latitude, longitude);

-- ── SOIL_REGIONAL_DEFAULTS (baseline soil characteristics per region) ──
-- Also populated by an ingestion/curation job, not derived at request time.

CREATE TABLE soil_regional_defaults (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  zip_or_postal      VARCHAR(20) UNIQUE,
  ph                 NUMERIC(3,1),
  nitrogen_pct       NUMERIC(5,2),
  phosphorus_pct     NUMERIC(5,2),
  potassium_pct      NUMERIC(5,2),
  description        TEXT
);

-- ── BEDS (phase 2 garden-bed mapping, included now so user_crops can reference it) ──

CREATE TABLE beds (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  region_id    UUID NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  name         VARCHAR(100) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_beds_region ON beds(region_id);

-- ── CROPS (reference table, not user-specific) ─────────────────

CREATE TABLE crops (
  id                                VARCHAR(50) PRIMARY KEY,
  name                              VARCHAR(100) NOT NULL,
  emoji                             VARCHAR(10),
  days_to_maturity                  INTEGER NOT NULL,
  start_method                      crop_start_method NOT NULL,
  zone_min                          INTEGER,
  zone_max                          INTEGER,
  companions                        TEXT[],
  soil_ph_min                       NUMERIC(3,1),
  soil_ph_max                       NUMERIC(3,1),
  weeks_before_last_frost_indoor    INTEGER NOT NULL DEFAULT 0,
  sow_buffer_days_after_frost       INTEGER NOT NULL DEFAULT 0,
  frost_tolerant                    BOOLEAN NOT NULL DEFAULT false
);

-- ── USER_CROPS (a user's tracked crops, optionally assigned to a bed) ──

CREATE TABLE user_crops (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  crop_id         VARCHAR(50) NOT NULL REFERENCES crops(id),
  bed_id          UUID REFERENCES beds(id) ON DELETE SET NULL,
  planted_date    DATE,
  status          user_crop_status NOT NULL DEFAULT 'planned',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, crop_id, bed_id)
);

CREATE INDEX idx_user_crops_user ON user_crops(user_id);
CREATE INDEX idx_user_crops_crop ON user_crops(crop_id);

-- ── SOIL_PROFILES ────────────────────────────────────────────

CREATE TABLE soil_profiles (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  region_id         UUID REFERENCES regions(id) ON DELETE CASCADE,
  ph                NUMERIC(3,1),
  nitrogen_pct      NUMERIC(5,2),
  phosphorus_pct    NUMERIC(5,2),
  potassium_pct     NUMERIC(5,2),
  source            soil_source NOT NULL DEFAULT 'regional_default',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_soil_profiles_user ON soil_profiles(user_id);

-- ── SCHEDULE_ITEMS (generated by the date-math engine) ─────────

CREATE TABLE schedule_items (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_crop_id     UUID NOT NULL REFERENCES user_crops(id) ON DELETE CASCADE,
  title            VARCHAR(255) NOT NULL,
  target_date      DATE NOT NULL,
  status           schedule_status NOT NULL DEFAULT 'future',
  reminder_sent    BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_schedule_items_user_crop ON schedule_items(user_crop_id);
CREATE INDEX idx_schedule_items_target_date ON schedule_items(target_date);
CREATE INDEX idx_schedule_items_pending_reminders ON schedule_items(target_date, reminder_sent) WHERE reminder_sent = false;

-- ── PURCHASES (in-app purchase receipts, server-verified) ──────

CREATE TABLE purchases (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform          purchase_platform NOT NULL,
  product_id        VARCHAR(100) NOT NULL,
  transaction_id    VARCHAR(255) NOT NULL UNIQUE,
  receipt_data      TEXT,
  verified_at       TIMESTAMPTZ,
  status            purchase_status NOT NULL DEFAULT 'valid',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_purchases_user ON purchases(user_id);

ALTER TABLE users
  ADD CONSTRAINT fk_users_ad_free_purchase
  FOREIGN KEY (ad_free_purchase_id) REFERENCES purchases(id) ON DELETE SET NULL;

-- ── AI ASSISTANT ─────────────────────────────────────────────

CREATE TABLE ai_conversations (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_conversations_user ON ai_conversations(user_id);

CREATE TABLE ai_messages (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id   UUID NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role              ai_message_role NOT NULL,
  content           TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_messages_conversation ON ai_messages(conversation_id, created_at);

CREATE TABLE ai_usage (
  user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_count_month      INTEGER NOT NULL DEFAULT 0,
  message_count_month    INTEGER NOT NULL DEFAULT 0,
  period_start           DATE NOT NULL DEFAULT date_trunc('month', now())::date
);

-- ── updated_at TRIGGER ───────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_regions_updated_at
  BEFORE UPDATE ON regions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_user_crops_updated_at
  BEFORE UPDATE ON user_crops FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_ai_conversations_updated_at
  BEFORE UPDATE ON ai_conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_soil_profiles_updated_at
  BEFORE UPDATE ON soil_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── SEED DATA: reference crops (matches the app prototype) ─────

INSERT INTO crops (id, name, emoji, days_to_maturity, start_method, zone_min, zone_max, companions, soil_ph_min, soil_ph_max, weeks_before_last_frost_indoor, sow_buffer_days_after_frost, frost_tolerant) VALUES
  ('tomato',   'Tomato',   '🍅', 75, 'transplant', 6, 10, ARRAY['Basil','Carrot'],  6.0, 6.8, 6, 14, false),
  ('pepper',   'Pepper',   '🫑', 80, 'transplant', 5, 11, ARRAY['Basil','Tomato'], 6.0, 6.8, 8, 14, false),
  ('lettuce',  'Lettuce',  '🥬', 45, 'seed',       4, 9,  ARRAY['Carrot','Radish'],6.0, 7.0, 0, 0,  true),
  ('cucumber', 'Cucumber', '🥒', 60, 'seed',       4, 11, ARRAY['Beans','Dill'],   6.0, 7.0, 0, 14, false),
  ('squash',   'Squash',   '🎃', 50, 'seed',       3, 10, ARRAY['Corn','Beans'],   6.0, 7.5, 0, 14, false),
  ('carrot',   'Carrot',   '🥕', 70, 'seed',       3, 10, ARRAY['Tomato','Lettuce'],6.0,6.8, 0, 0,  true),
  ('basil',    'Basil',    '🌿', 30, 'transplant', 5, 11, ARRAY['Tomato','Pepper'],6.0, 7.0, 6, 14, false),
  ('beans',    'Beans',    '🫘', 55, 'seed',       3, 10, ARRAY['Corn','Squash'],  6.0, 7.0, 0, 7,  false);

-- ============================================================
-- End of schema v1
-- ============================================================
