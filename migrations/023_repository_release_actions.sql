CREATE TABLE repository_release_actions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL,
  action_id text NOT NULL,
  target_hash text NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('reserved','dispatched','confirmed','unknown')),
  data jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,task_id,action_id),
  UNIQUE(workspace_id,target_hash)
);
