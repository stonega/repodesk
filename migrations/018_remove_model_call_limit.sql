-- Retire the workspace model-call quota; historical run snapshots remain audit evidence.
UPDATE workspaces
SET data = jsonb_set(jsonb_set(data, '{settings}', (data->'settings') - 'maxTurns'),
    '{version}', to_jsonb((data->>'version')::integer + 1)),
    updated_at = now()
WHERE (data->'settings') ? 'maxTurns';
