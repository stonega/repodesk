-- Shared account tokens never become personal grants. Keep registered clients for reuse.
UPDATE workspaces
SET data = jsonb_set(data, '{plugins,google}', (
  SELECT jsonb_object_agg(key, value - 'connection' - 'flow')
  FROM jsonb_each(data->'plugins'->'google')
))
WHERE jsonb_typeof(data->'plugins'->'google') = 'object'
  AND data->'plugins'->'google' <> '{}'::jsonb;
UPDATE workspaces
SET data = data #- '{plugins,searchConsole}'
WHERE data->'plugins' ? 'searchConsole';
