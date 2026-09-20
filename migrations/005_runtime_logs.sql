CREATE TABLE runtime_logs (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  service text NOT NULL CHECK(service IN ('app','worker')),
  level text NOT NULL CHECK(level IN ('info','warn','error')),
  event text NOT NULL,
  code text,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id uuid,
  retry_delay_ms integer CHECK(retry_delay_ms BETWEEN 0 AND 86400000),
  CHECK (run_id IS NULL OR workspace_id IS NOT NULL)
);
CREATE INDEX runtime_logs_at ON runtime_logs(at);
CREATE INDEX runtime_logs_workspace ON runtime_logs(workspace_id, id DESC);
