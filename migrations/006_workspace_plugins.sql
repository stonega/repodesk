-- Copy only existing grants into independent workspace registries. An explicit
-- empty registry must stay empty rather than reactivating the manifest fallback.
WITH legacy AS (
  SELECT w.id, d.data->'plugins'->(w.data->>'operatorId') AS settings
  FROM workspaces w CROSS JOIN deployment d
  WHERE d.data->'plugins' ? (w.data->>'operatorId')
    AND NOT (w.data ? 'plugins') AND NOT (w.data ? 'deletion')
), scoped AS (
  SELECT id, jsonb_build_object(
    'revision', COALESCE(settings->'revision', '0'::jsonb),
    'entries', COALESCE((
      SELECT jsonb_agg(jsonb_set(entry, '{workspaces}', jsonb_build_array(id::text)))
      FROM jsonb_array_elements(settings->'entries') entry
      WHERE entry->'workspaces' ? id::text
    ), '[]'::jsonb),
    'codeTruth', jsonb_build_object(
      'enabled', COALESCE(settings->'codeTruth'->'enabled', 'false'::jsonb),
      'repositories', COALESCE((
        SELECT jsonb_agg(jsonb_set(repo, '{workspaces}', jsonb_build_array(id::text)))
        FROM jsonb_array_elements(settings->'codeTruth'->'repositories') repo
        WHERE repo->'workspaces' ? id::text
      ), '[]'::jsonb)
    )
  ) AS settings FROM legacy
)
UPDATE workspaces w SET data = jsonb_set(w.data, '{plugins}', scoped.settings), updated_at = now()
FROM scoped WHERE w.id = scoped.id;

UPDATE deployment SET data = data - 'plugins' WHERE data ? 'plugins';
