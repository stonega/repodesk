-- Drop retired workspace controls; historical run snapshots remain available for audit.
UPDATE workspaces
SET data = jsonb_set(jsonb_set(data, '{settings}', (data->'settings') - 'language' - 'maxInputChars' - 'maxOutputTokens'), '{version}', to_jsonb((data->>'version')::integer + 1)),
    updated_at = now()
WHERE (data->'settings') ?| ARRAY['language', 'maxInputChars', 'maxOutputTokens'];
