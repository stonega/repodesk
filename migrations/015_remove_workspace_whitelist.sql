-- All active members can use the bot. Preserve the concurrency revision used by
-- membership edits and access-request decisions; discard the retired whitelist.
UPDATE workspaces
SET data = jsonb_set(data - 'policy', '{memberVersion}',
  COALESCE(data->'memberVersion', data #> '{policy,version}', '1'::jsonb)),
  updated_at = now()
WHERE data ? 'policy' OR NOT data ? 'memberVersion';
