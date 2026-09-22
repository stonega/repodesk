-- Fixed access replies remain separate from authorized workspace deliveries.
ALTER TABLE control_deliveries
  ADD COLUMN workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  ADD COLUMN chat_id text,
  ADD COLUMN topic_id integer;
