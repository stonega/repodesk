CREATE TABLE telegram_selections (actor text PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id));
