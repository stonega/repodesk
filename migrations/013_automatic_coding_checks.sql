-- Remove obsolete operator commands. Increment coding revisions so old grants
-- cannot silently change their execution contract during an upgrade.
UPDATE workspaces w
SET data = jsonb_set(
  jsonb_set(
    jsonb_set(w.data, '{coding,settings,repositories}', (
      SELECT jsonb_agg(repo - 'setupCommand' - 'checkCommand' ORDER BY ordinal)
      FROM jsonb_array_elements(w.data #> '{coding,settings,repositories}')
        WITH ORDINALITY AS entries(repo, ordinal)
    )),
    '{coding,revision}', to_jsonb((w.data #>> '{coding,revision}')::integer + 1)
  ),
  '{version}', to_jsonb((w.data->>'version')::integer + 1)
), updated_at = now()
WHERE jsonb_typeof(w.data #> '{coding,settings,repositories}') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(w.data #> '{coding,settings,repositories}') AS repo
    WHERE repo ? 'setupCommand' OR repo ? 'checkCommand'
  );
