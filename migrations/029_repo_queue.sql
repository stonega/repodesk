-- Per-repository sequential task queues with pin/reorder, pause/resume, and artifact carryover.
CREATE TABLE IF NOT EXISTS workspace_repo_queues (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  repository_id bigint NOT NULL,
  paused boolean NOT NULL DEFAULT false,
  concurrency int NOT NULL DEFAULT 1,
  revision int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (workspace_id, repository_id)
);

CREATE TABLE IF NOT EXISTS workspace_repo_queue_items (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL,
  repository_id bigint NOT NULL,
  mission_id text,
  coding_task_id text,
  actor text NOT NULL,
  chat_id text NOT NULL,
  topic_id int NOT NULL DEFAULT 0,
  priority int NOT NULL DEFAULT 0,
  position int NOT NULL DEFAULT 0,
  status text NOT NULL,
  carryover_enabled boolean NOT NULL DEFAULT true,
  carryover_source_task_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS workspace_repo_queue_items_order
  ON workspace_repo_queue_items(workspace_id, repository_id, status, priority DESC, position ASC);

CREATE INDEX IF NOT EXISTS workspace_repo_queue_items_task
  ON workspace_repo_queue_items(workspace_id, coding_task_id)
  WHERE coding_task_id IS NOT NULL;
