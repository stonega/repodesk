-- Deployment-scoped reservations survive restarts and fence duplicate host jobs.
CREATE TABLE deployment_updates (
  repository text NOT NULL,
  release_id bigint NOT NULL,
  actor uuid NOT NULL REFERENCES admins(id),
  fingerprint text NOT NULL,
  state text NOT NULL CHECK (state IN ('dispatching','queued','running','succeeded','failed','unknown')),
  request_id uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repository, release_id)
);
