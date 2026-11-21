CREATE TABLE IF NOT EXISTS model_usage_events (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source_kind text NOT NULL,
  source_id text NOT NULL,
  source_label text NOT NULL,
  source_path text,
  actor text NOT NULL DEFAULT '',
  provider_id text,
  provider_name text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  status text NOT NULL,
  stop_reason text,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_write_tokens bigint NOT NULL DEFAULT 0,
  reasoning_tokens bigint NOT NULL DEFAULT 0,
  total_tokens bigint NOT NULL DEFAULT 0,
  estimated_input_tokens bigint,
  token_breakdown_known boolean NOT NULL DEFAULT false,
  reserved_usd double precision NOT NULL DEFAULT 0,
  actual_usd double precision,
  accounted_usd double precision NOT NULL DEFAULT 0,
  pricing_unknown boolean NOT NULL DEFAULT false,
  latency_ms integer,
  tool_calls integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS model_usage_events_ws_recorded_idx
  ON model_usage_events (workspace_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS model_usage_events_ws_source_idx
  ON model_usage_events (workspace_id, source_kind, recorded_at DESC);

CREATE INDEX IF NOT EXISTS model_usage_events_ws_model_idx
  ON model_usage_events (workspace_id, model, recorded_at DESC);

CREATE INDEX IF NOT EXISTS model_usage_events_ws_actor_idx
  ON model_usage_events (workspace_id, actor, recorded_at DESC);

CREATE INDEX IF NOT EXISTS model_usage_events_ws_source_id_idx
  ON model_usage_events (workspace_id, source_id);

-- Backfill existing run attempts from workspace_runs
INSERT INTO model_usage_events (
  workspace_id, id, recorded_at, source_kind, source_id, source_label, source_path,
  actor, provider_id, provider_name, model, status, stop_reason,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
  estimated_input_tokens, token_breakdown_known,
  reserved_usd, actual_usd, accounted_usd, pricing_unknown,
  latency_ms, tool_calls, metadata
)
SELECT
  r.workspace_id,
  'run:' || r.id || ':' || COALESCE(a->>'id', ord::text),
  COALESCE(NULLIF(a->>'at', '')::timestamptz, NULLIF(r.created_at, '')::timestamptz, now()),
  CASE
    WHEN a->>'purpose' IN ('compaction', 'followup', 'memory_extract', 'memory_consolidate', 'research_subagent')
      THEN a->>'purpose'
    WHEN r.workflow_id IS NOT NULL THEN 'workflow'
    WHEN r.data->>'triggerKind' = 'mission_wakeup' OR r.mission_id IS NOT NULL THEN 'mission'
    ELSE 'chat'
  END,
  r.id,
  CASE
    WHEN a->>'purpose' = 'compaction' THEN 'Context compaction'
    WHEN a->>'purpose' = 'followup' THEN 'Follow-up classifier'
    WHEN a->>'purpose' = 'memory_extract' THEN 'Memory extraction'
    WHEN a->>'purpose' = 'memory_consolidate' THEN 'Memory consolidation'
    WHEN a->>'purpose' = 'research_subagent' THEN 'Research subagent'
    WHEN r.workflow_id IS NOT NULL THEN 'Workflow · ' || r.workflow_id
    WHEN r.mission_id IS NOT NULL THEN 'Mission · ' || r.mission_id
    WHEN r.chat_id = r.actor THEN 'Private chat'
    ELSE 'Group chat'
  END,
  '/admin/runs/' || r.id,
  COALESCE(r.actor, ''),
  COALESCE(a->>'providerId', r.data->'modelProvider'->>'id'),
  COALESCE(NULLIF(a->>'providerName', ''), NULLIF(r.data->'modelOptions'->>'modelBaseUrl', ''), 'Deployment default'),
  COALESCE(NULLIF(a->>'model', ''), NULLIF(r.data->>'model', ''), 'unknown'),
  COALESCE(NULLIF(a->>'status', ''), 'unknown'),
  a->>'stopReason',
  COALESCE((a->'tokens'->>'input')::bigint, 0),
  COALESCE((a->'tokens'->>'output')::bigint, 0),
  COALESCE((a->'tokens'->>'cacheRead')::bigint, 0),
  COALESCE((a->'tokens'->>'cacheWrite')::bigint, 0),
  COALESCE((a->'tokens'->>'reasoning')::bigint, 0),
  COALESCE((a->'tokens'->>'input')::bigint, 0)
    + COALESCE((a->'tokens'->>'output')::bigint, 0)
    + COALESCE((a->'tokens'->>'cacheRead')::bigint, 0)
    + COALESCE((a->'tokens'->>'cacheWrite')::bigint, 0),
  (a->>'estimatedInputTokens')::bigint,
  (a->'tokens' IS NOT NULL),
  COALESCE((a->>'reserved')::double precision, 0),
  (a->>'actual')::double precision,
  COALESCE(
    (a->>'actual')::double precision,
    CASE WHEN COALESCE((a->>'pricingUnknown')::boolean, false) THEN 0 ELSE COALESCE((a->>'reserved')::double precision, 0) END
  ),
  COALESCE((a->>'pricingUnknown')::boolean, false),
  (a->>'latencyMs')::integer,
  COALESCE((a->>'toolCalls')::integer, 0),
  jsonb_strip_nulls(jsonb_build_object(
    'runId', r.id,
    'attemptId', a->>'id',
    'threadId', r.thread_id,
    'workflowId', r.workflow_id,
    'missionId', r.mission_id,
    'purpose', a->>'purpose',
    'chatScope', CASE WHEN r.chat_id = r.actor THEN 'private' ELSE 'group' END
  ))
FROM workspace_runs r
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.data->'attempts', '[]'::jsonb)) WITH ORDINALITY AS t(a, ord)
ON CONFLICT (workspace_id, id) DO NOTHING;

-- Backfill existing admin self-check attempts
INSERT INTO model_usage_events (
  workspace_id, id, recorded_at, source_kind, source_id, source_label, source_path,
  actor, provider_id, provider_name, model, status, stop_reason,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
  estimated_input_tokens, token_breakdown_known,
  reserved_usd, actual_usd, accounted_usd, pricing_unknown,
  latency_ms, tool_calls, metadata
)
SELECT
  w.id,
  'self_check:' || (c->>'id') || ':' || COALESCE(a->>'id', ord::text),
  COALESCE(NULLIF(a->>'at', '')::timestamptz, NULLIF(c->>'at', '')::timestamptz, now()),
  'self_check',
  COALESCE(c->>'id', ''),
  'Admin self-check',
  NULL,
  COALESCE(c->>'actor', c->>'adminId', ''),
  COALESCE(a->>'providerId', c->>'providerId'),
  COALESCE(NULLIF(a->>'providerName', ''), NULLIF(c->>'providerName', ''), 'Deployment default'),
  COALESCE(NULLIF(a->>'model', ''), NULLIF(c->>'model', ''), 'unknown'),
  COALESCE(NULLIF(a->>'status', ''), 'unknown'),
  a->>'stopReason',
  COALESCE((a->'tokens'->>'input')::bigint, 0),
  COALESCE((a->'tokens'->>'output')::bigint, 0),
  COALESCE((a->'tokens'->>'cacheRead')::bigint, 0),
  COALESCE((a->'tokens'->>'cacheWrite')::bigint, 0),
  COALESCE((a->'tokens'->>'reasoning')::bigint, 0),
  COALESCE((a->'tokens'->>'input')::bigint, 0)
    + COALESCE((a->'tokens'->>'output')::bigint, 0)
    + COALESCE((a->'tokens'->>'cacheRead')::bigint, 0)
    + COALESCE((a->'tokens'->>'cacheWrite')::bigint, 0),
  (a->>'estimatedInputTokens')::bigint,
  (a->'tokens' IS NOT NULL),
  COALESCE((a->>'reserved')::double precision, 0),
  (a->>'actual')::double precision,
  COALESCE(
    (a->>'actual')::double precision,
    CASE WHEN COALESCE((a->>'pricingUnknown')::boolean, false) THEN 0 ELSE COALESCE((a->>'reserved')::double precision, 0) END
  ),
  COALESCE((a->>'pricingUnknown')::boolean, false),
  (a->>'latencyMs')::integer,
  COALESCE((a->>'toolCalls')::integer, 0),
  jsonb_strip_nulls(jsonb_build_object(
    'checkId', c->>'id',
    'adminId', c->>'adminId',
    'attemptId', a->>'id',
    'chatScope', 'admin'
  ))
FROM workspaces w
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'adminChecks', '[]'::jsonb)) AS c
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(c->'attempts', '[]'::jsonb)) WITH ORDINALITY AS t(a, ord)
ON CONFLICT (workspace_id, id) DO NOTHING;

-- Backfill existing Codex coding task attempts
INSERT INTO model_usage_events (
  workspace_id, id, recorded_at, source_kind, source_id, source_label, source_path,
  actor, provider_id, provider_name, model, status, stop_reason,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
  estimated_input_tokens, token_breakdown_known,
  reserved_usd, actual_usd, accounted_usd, pricing_unknown,
  latency_ms, tool_calls, metadata
)
SELECT
  a.workspace_id,
  'coding:' || a.task_id::text || ':' || a.id::text,
  COALESCE(
    CASE WHEN (a.data->>'endedAt') ~ '^[0-9]+$' THEN to_timestamp(((a.data->>'endedAt')::double precision) / 1000.0) END,
    a.created_at,
    now()
  ),
  CASE WHEN a.data->>'kind' = 'conversation' THEN 'coding_conversation' ELSE 'coding_task' END,
  a.task_id::text,
  CASE WHEN a.data->>'kind' = 'conversation' THEN 'Codex Q&A · ' ELSE 'Codex · ' END
    || COALESCE(NULLIF(ct.data->'payload'->>'repository', ''), a.task_id::text),
  '/admin/plugins/codex',
  COALESCE(ct.data->>'actor', ''),
  ct.data->'runnerModel'->>'id',
  COALESCE(
    NULLIF(ct.data->'runnerModel'->>'name', ''),
    NULLIF(ct.data->'runnerModel'->>'baseUrl', ''),
    CASE WHEN ct.data->'payload'->>'authMode' = 'chatgpt' THEN 'Codex ChatGPT' ELSE 'Codex runner' END
  ),
  COALESCE(NULLIF(ct.data->'runnerModel'->>'model', ''), 'codex'),
  CASE WHEN a.state = 'done' THEN 'settled' WHEN a.state = 'unknown' THEN 'unknown' ELSE 'reserved' END,
  NULL,
  COALESCE((a.data->'tokenUsage'->>'input')::bigint, 0),
  COALESCE((a.data->'tokenUsage'->>'output')::bigint, 0),
  COALESCE((a.data->'tokenUsage'->>'cacheRead')::bigint, 0),
  COALESCE((a.data->'tokenUsage'->>'cacheWrite')::bigint, 0),
  COALESCE((a.data->'tokenUsage'->>'reasoning')::bigint, 0),
  COALESCE((a.data->>'tokens')::bigint, 0),
  NULL,
  (a.data->'tokenUsage' IS NOT NULL),
  0,
  NULL,
  0,
  true,
  CASE
    WHEN (a.data->>'startedAt') ~ '^[0-9]+$' AND (a.data->>'endedAt') ~ '^[0-9]+$'
      THEN GREATEST(0, LEAST(2147483647, ((a.data->>'endedAt')::bigint - (a.data->>'startedAt')::bigint)))::integer
    ELSE NULL
  END,
  0,
  jsonb_strip_nulls(jsonb_build_object(
    'taskId', a.task_id,
    'attemptId', a.id,
    'repository', ct.data->'payload'->>'repository',
    'phase', ct.data->>'phase',
    'usageUnknown', COALESCE((a.data->>'usageUnknown')::boolean, false)
  ))
FROM coding_task_attempts a
LEFT JOIN coding_tasks ct ON ct.workspace_id = a.workspace_id AND ct.id = a.task_id
WHERE (a.data->>'tokens') IS NOT NULL OR a.state IN ('done', 'unknown')
ON CONFLICT (workspace_id, id) DO NOTHING;

-- Backfill existing Review Bot tasks with recorded tokens
INSERT INTO model_usage_events (
  workspace_id, id, recorded_at, source_kind, source_id, source_label, source_path,
  actor, provider_id, provider_name, model, status, stop_reason,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
  estimated_input_tokens, token_breakdown_known,
  reserved_usd, actual_usd, accounted_usd, pricing_unknown,
  latency_ms, tool_calls, metadata
)
SELECT
  w.id,
  'review:' || (rt->>'id') || ':' || COALESCE(rt->>'attemptId', '0'),
  COALESCE(NULLIF(rt->>'updatedAt', '')::timestamptz, NULLIF(rt->>'createdAt', '')::timestamptz, now()),
  'review_bot',
  COALESCE(rt->>'id', ''),
  'Review Bot · ' || COALESCE(NULLIF(rt->'payload'->>'repository', ''), 'PR') || ' #' || COALESCE(rt->>'number', '?'),
  '/admin/plugins/review-bot',
  COALESCE(rt->>'actor', ''),
  rt->'runnerModel'->>'id',
  COALESCE(
    NULLIF(rt->'runnerModel'->>'name', ''),
    NULLIF(rt->'runnerModel'->>'baseUrl', ''),
    CASE WHEN rt->'payload'->>'authMode' = 'chatgpt' THEN 'Codex ChatGPT' ELSE 'Codex runner' END
  ),
  COALESCE(NULLIF(rt->'runnerModel'->>'model', ''), 'codex'),
  CASE
    WHEN rt->>'state' = 'completed' THEN 'settled'
    WHEN rt->>'state' IN ('failed', 'cancelled') THEN 'failed'
    WHEN rt->>'state' = 'unknown' THEN 'unknown'
    ELSE 'reserved'
  END,
  NULL,
  COALESCE((rt->'tokenUsage'->>'input')::bigint, 0),
  COALESCE((rt->'tokenUsage'->>'output')::bigint, 0),
  COALESCE((rt->'tokenUsage'->>'cacheRead')::bigint, 0),
  COALESCE((rt->'tokenUsage'->>'cacheWrite')::bigint, 0),
  COALESCE((rt->'tokenUsage'->>'reasoning')::bigint, 0),
  COALESCE((rt->>'tokens')::bigint, 0),
  NULL,
  (rt->'tokenUsage' IS NOT NULL),
  0,
  NULL,
  0,
  true,
  NULL,
  0,
  jsonb_strip_nulls(jsonb_build_object(
    'reviewTaskId', rt->>'id',
    'attemptId', rt->>'attemptId',
    'repository', rt->'payload'->>'repository',
    'prNumber', (rt->>'number')::integer,
    'mode', rt->>'mode',
    'usageUnknown', COALESCE((rt->>'usageUnknown')::boolean, false),
    'chatScope', 'github'
  ))
FROM workspaces w
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'reviewTasks', '[]'::jsonb)) AS rt
WHERE (rt->>'tokens') IS NOT NULL
ON CONFLICT (workspace_id, id) DO NOTHING;
