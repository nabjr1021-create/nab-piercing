BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- add token column WITHOUT default so existing rows stay NULL
ALTER TABLE IF EXISTS bookings
  ADD COLUMN IF NOT EXISTS confirmation_token UUID;

-- add sending tracking columns (no backfill)
ALTER TABLE IF EXISTS bookings
  ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS bookings
  ADD COLUMN IF NOT EXISTS confirmation_sending_started_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS bookings
  ADD COLUMN IF NOT EXISTS confirmation_message_id TEXT;

-- Now set DEFAULT for future rows only (does not change existing rows)
ALTER TABLE IF EXISTS bookings
  ALTER COLUMN confirmation_token SET DEFAULT gen_random_uuid();

-- Index for lookup by token
CREATE INDEX IF NOT EXISTS idx_bookings_confirmation_token ON bookings (confirmation_token);

COMMIT;
