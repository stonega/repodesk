-- Transport metadata only: message contents remain in the existing scoped ingress.
CREATE TABLE telegram_polling (
  bot_id text PRIMARY KEY,
  next_offset bigint,
  last_update_at timestamptz,
  credential_hash text NOT NULL,
  ready_at timestamptz,
  retry_at timestamptz,
  error text,
  owner_id text
);
