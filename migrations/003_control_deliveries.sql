-- Only fixed onboarding/access-help text can be delivered without workspace membership.
CREATE TABLE control_deliveries (
  bot_id text NOT NULL, update_id bigint NOT NULL, actor text NOT NULL,
  state text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz,
  next_at timestamptz NOT NULL DEFAULT now(), remote_id bigint,
  PRIMARY KEY(bot_id,update_id)
);
CREATE INDEX control_deliveries_due ON control_deliveries(next_at) WHERE state='pending';
