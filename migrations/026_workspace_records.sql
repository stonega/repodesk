-- Move high-frequency workspace collections out of workspaces.data JSONB into
-- indexed, tenant-scoped relational tables.
CREATE TABLE IF NOT EXISTS workspace_messages (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  seq int NOT NULL,
  chat_id text NOT NULL,
  thread_id text,
  created_at text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS workspace_messages_order
  ON workspace_messages(workspace_id, seq);
CREATE INDEX IF NOT EXISTS workspace_messages_chat
  ON workspace_messages(workspace_id, chat_id, created_at);

CREATE TABLE IF NOT EXISTS workspace_runs (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  seq int NOT NULL,
  status text NOT NULL,
  workflow_id text,
  thread_id text,
  actor text NOT NULL,
  chat_id text NOT NULL,
  topic_id int NOT NULL DEFAULT 0,
  draft_id bigint,
  draft_bot_id text,
  created_at text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS workspace_runs_order
  ON workspace_runs(workspace_id, seq);
CREATE INDEX IF NOT EXISTS workspace_runs_status
  ON workspace_runs(workspace_id, status);
CREATE INDEX IF NOT EXISTS workspace_runs_draft
  ON workspace_runs(actor, chat_id, topic_id, draft_id, draft_bot_id)
  WHERE draft_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_deliveries (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  seq int NOT NULL,
  state text NOT NULL,
  run_id text,
  chat_id text NOT NULL,
  created_at text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS workspace_deliveries_order
  ON workspace_deliveries(workspace_id, seq);
CREATE INDEX IF NOT EXISTS workspace_deliveries_state
  ON workspace_deliveries(workspace_id, state);
CREATE INDEX IF NOT EXISTS workspace_deliveries_run
  ON workspace_deliveries(workspace_id, run_id)
  WHERE run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_audit (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  seq int NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  created_at text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS workspace_audit_order
  ON workspace_audit(workspace_id, seq);

-- Backfill existing records from workspaces.data JSONB, preserving array order.
INSERT INTO workspace_messages (workspace_id, id, seq, chat_id, thread_id, created_at, data)
SELECT
  w.id,
  elem.item->>'id',
  elem.seq::int,
  COALESCE(elem.item->>'chatId', ''),
  elem.item->>'threadId',
  COALESCE(elem.item->>'at', ''),
  elem.item
FROM workspaces w
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'messages', '[]'::jsonb)) WITH ORDINALITY AS elem(item, seq)
WHERE w.data ? 'messages' AND elem.item ? 'id'
ON CONFLICT (workspace_id, id) DO NOTHING;

INSERT INTO workspace_runs (workspace_id, id, seq, status, workflow_id, thread_id, actor, chat_id, topic_id, draft_id, draft_bot_id, created_at, data)
SELECT
  w.id,
  elem.item->>'id',
  elem.seq::int,
  COALESCE(elem.item->>'status', ''),
  elem.item->>'workflowId',
  elem.item->>'threadId',
  COALESCE(elem.item->>'actor', ''),
  COALESCE(elem.item->>'chatId', ''),
  CASE WHEN (elem.item->>'topicId') ~ '^-?[0-9]+$' THEN (elem.item->>'topicId')::int ELSE 0 END,
  CASE WHEN (elem.item->'telegramDraft'->>'id') ~ '^-?[0-9]+$' THEN (elem.item->'telegramDraft'->>'id')::bigint END,
  elem.item->'telegramDraft'->>'botId',
  COALESCE(elem.item->>'at', ''),
  elem.item
FROM workspaces w
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'runs', '[]'::jsonb)) WITH ORDINALITY AS elem(item, seq)
WHERE w.data ? 'runs' AND elem.item ? 'id'
ON CONFLICT (workspace_id, id) DO NOTHING;

INSERT INTO workspace_deliveries (workspace_id, id, seq, state, run_id, chat_id, created_at, data)
SELECT
  w.id,
  elem.item->>'id',
  elem.seq::int,
  COALESCE(elem.item->>'state', ''),
  elem.item->>'runId',
  COALESCE(elem.item->>'chatId', ''),
  COALESCE(elem.item->>'at', ''),
  elem.item
FROM workspaces w
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'deliveries', '[]'::jsonb)) WITH ORDINALITY AS elem(item, seq)
WHERE w.data ? 'deliveries' AND elem.item ? 'id'
ON CONFLICT (workspace_id, id) DO NOTHING;

INSERT INTO workspace_audit (workspace_id, id, seq, actor, action, created_at, data)
SELECT
  w.id,
  elem.item->>'id',
  elem.seq::int,
  COALESCE(elem.item->>'actor', ''),
  COALESCE(elem.item->>'action', ''),
  COALESCE(elem.item->>'at', ''),
  elem.item
FROM workspaces w
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'audit', '[]'::jsonb)) WITH ORDINALITY AS elem(item, seq)
WHERE w.data ? 'audit' AND elem.item ? 'id'
ON CONFLICT (workspace_id, id) DO NOTHING;

UPDATE workspaces
SET data = data - 'messages' - 'runs' - 'deliveries' - 'audit'
WHERE data ?| ARRAY['messages', 'runs', 'deliveries', 'audit'];
