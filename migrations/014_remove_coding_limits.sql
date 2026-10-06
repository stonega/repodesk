-- Retire user-configurable Codex quotas without changing repository authority.
UPDATE workspaces w
SET data = jsonb_set(w.data, '{coding,settings,repositories}', (
  SELECT jsonb_agg(
    CASE WHEN jsonb_typeof(repo->'development') = 'object'
      THEN jsonb_set(repo, '{development}',
        (repo->'development') - ARRAY['maxAttempts','maxRepairAttempts','activeSeconds','maxTokens'])
      ELSE repo
    END ORDER BY position
  )
  FROM jsonb_array_elements(w.data #> '{coding,settings,repositories}')
    WITH ORDINALITY AS items(repo, position)
))
WHERE jsonb_typeof(w.data #> '{coding,settings,repositories}') = 'array'
  AND EXISTS (
    SELECT 1 FROM jsonb_array_elements(w.data #> '{coding,settings,repositories}') repo
    WHERE (repo->'development') ?| ARRAY['maxAttempts','maxRepairAttempts','activeSeconds','maxTokens']
  );

UPDATE coding_tasks
SET data = jsonb_set(data, '{policy}',
  (data->'policy') - ARRAY['maxAttempts','maxRepairAttempts','activeSeconds','maxTokens'])
WHERE jsonb_typeof(data->'policy') = 'object';

-- Old unknown turns reserved the remaining quota as if it were actual usage.
-- Keep only reported usage and mark incomplete totals explicitly. Historical
-- grants and attempt envelopes remain unchanged as audit evidence.
UPDATE coding_tasks t
SET data = jsonb_set(jsonb_set(t.data, '{tokens}', (
  SELECT to_jsonb(COALESCE(SUM((a.data->>'tokens')::numeric), 0))
  FROM coding_task_attempts a
  WHERE a.workspace_id = t.workspace_id AND a.task_id = t.id
    AND jsonb_typeof(a.data->'tokens') = 'number'
)), '{usageUnknown}', to_jsonb(EXISTS (
  SELECT 1 FROM coding_task_attempts a
  WHERE a.workspace_id = t.workspace_id AND a.task_id = t.id
    AND (a.data->>'usageUnknown' = 'true'
      OR (a.state IN ('done','unknown') AND a.data ? 'endedAt'
        AND jsonb_typeof(a.data->'tokens') IS DISTINCT FROM 'number'))
)));
