CREATE TABLE coding_tasks (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  id uuid NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id)
);
CREATE TABLE coding_task_inputs (
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  source_key text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,task_id,revision),
  UNIQUE (workspace_id,source_key),
  FOREIGN KEY (workspace_id,task_id) REFERENCES coding_tasks(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE coding_task_grants (
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  revision integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (workspace_id,task_id,revision),
  FOREIGN KEY (workspace_id,task_id) REFERENCES coding_tasks(workspace_id,id) ON DELETE CASCADE
);
CREATE TABLE coding_task_attempts (
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  id uuid NOT NULL,
  fence integer NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','running','publishing','done','unknown')),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,id),
  UNIQUE (workspace_id,task_id,fence),
  FOREIGN KEY (workspace_id,task_id) REFERENCES coding_tasks(workspace_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX coding_task_live_attempt ON coding_task_attempts(workspace_id,task_id)
  WHERE state IN ('reserved','running','publishing');
CREATE TABLE coding_task_events (
  workspace_id uuid NOT NULL,
  task_id uuid NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,task_id,id),
  FOREIGN KEY (workspace_id,task_id) REFERENCES coding_tasks(workspace_id,id) ON DELETE CASCADE
);
