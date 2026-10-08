CREATE TABLE review_bot_hooks (
  operator_id uuid PRIMARY KEY REFERENCES admins(id),
  secret text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE review_bot_receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id bigint NOT NULL,
  delivery_id text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,app_id,delivery_id)
);
CREATE INDEX review_bot_receipts_expiry ON review_bot_receipts(accepted_at);
