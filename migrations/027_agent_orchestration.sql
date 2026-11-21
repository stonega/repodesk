-- Durable multi-step agent missions, wait graphs, and mission-linked runs.
CREATE TABLE IF NOT EXISTS workspace_missions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  actor text NOT NULL,
  chat_id text NOT NULL,
  topic_id int NOT NULL DEFAULT 0,
  thread_id text,
  bot_id text,
  status text NOT NULL,
  wakeup_count int NOT NULL DEFAULT 0,
  max_wakeups int NOT NULL DEFAULT 8,
  auto_timer_count int NOT NULL DEFAULT 0,
  max_auto_timers int NOT NULL DEFAULT 3,
  fence int NOT NULL DEFAULT 0,
  last_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS workspace_missions_status
  ON workspace_missions(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS workspace_missions_conversation
  ON workspace_missions(workspace_id, chat_id, topic_id, status);
CREATE INDEX IF NOT EXISTS workspace_missions_actor
  ON workspace_missions(workspace_id, actor, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_mission_waits (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mission_id text NOT NULL,
  id text NOT NULL,
  join_group text NOT NULL,
  join_mode text NOT NULL DEFAULT 'all',
  kind text NOT NULL,
  target_id text NOT NULL,
  status text NOT NULL,
  due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id)
    REFERENCES workspace_missions(workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS workspace_mission_waits_mission
  ON workspace_mission_waits(workspace_id, mission_id, status);
CREATE INDEX IF NOT EXISTS workspace_mission_waits_target
  ON workspace_mission_waits(workspace_id, kind, target_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS workspace_mission_waits_due
  ON workspace_mission_waits(due_at)
  WHERE kind = 'timer' AND status = 'pending' AND due_at IS NOT NULL;

ALTER TABLE workspace_runs
  ADD COLUMN IF NOT EXISTS mission_id text;

CREATE INDEX IF NOT EXISTS workspace_runs_mission
  ON workspace_runs(workspace_id, mission_id)
  WHERE mission_id IS NOT NULL;
