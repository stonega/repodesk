-- Groups remain exclusively bound to a workspace; a workspace may bind many groups.
ALTER TABLE chat_bindings DROP CONSTRAINT IF EXISTS chat_bindings_workspace_id_key;
CREATE INDEX IF NOT EXISTS chat_bindings_workspace_id ON chat_bindings(workspace_id);
