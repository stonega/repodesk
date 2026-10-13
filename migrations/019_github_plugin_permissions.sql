-- GitHub is the repository permission authority for Codex and Review Bot.
-- Preserve unanimous workflow choices; mixed legacy policies use conservative defaults.
DO $$
DECLARE
  row record;
  next_data jsonb;
  settings jsonb;
  mode text;
  publish boolean;
  automatic boolean;
  requests boolean;
  fixes boolean;
BEGIN
  FOR row IN SELECT id, data FROM workspaces
    WHERE (data#>'{coding,settings}') ? 'repositories'
       OR (data#>'{reviewBot,settings}') ? 'repositories'
  LOOP
    next_data := row.data;
    settings := next_data#>'{coding,settings}';
    IF settings ? 'repositories' THEN
      SELECT CASE WHEN count(*) > 0 AND bool_and(coalesce(r#>>'{development,executionMode}', 'reviewed') = 'direct')
        THEN 'direct' ELSE 'reviewed' END,
        coalesce(bool_and(coalesce((r#>>'{development,publishByDefault}')::boolean, false)), false)
        INTO mode, publish FROM jsonb_array_elements(settings->'repositories') r;
      next_data := jsonb_set(next_data, '{coding,settings}',
        (settings - 'repositories') || jsonb_build_object('development',
          coalesce(settings->'development', jsonb_build_object('executionMode', mode, 'publishByDefault', publish))));
      next_data := jsonb_set(next_data, '{coding,revision}', to_jsonb((next_data#>>'{coding,revision}')::integer + 1));
    END IF;
    settings := next_data#>'{reviewBot,settings}';
    IF settings ? 'repositories' THEN
      SELECT coalesce(bool_and(coalesce((r->>'autoReview')::boolean, true)), true),
        coalesce(bool_and(coalesce((r->>'acceptRequests')::boolean, true)), true),
        coalesce(bool_and(coalesce((r->>'allowFixes')::boolean, false)), false)
        INTO automatic, requests, fixes FROM jsonb_array_elements(settings->'repositories') r;
      -- Fixes remain off if the combined Codex workflow requires approval.
      fixes := fixes AND next_data#>>'{coding,settings,development,executionMode}' = 'direct';
      next_data := jsonb_set(next_data, '{reviewBot,settings}',
        (settings - 'repositories') || jsonb_build_object('autoReview', automatic, 'acceptRequests', requests, 'allowFixes', coalesce(fixes, false)));
      next_data := jsonb_set(next_data, '{reviewBot,revision}', to_jsonb((next_data#>>'{reviewBot,revision}')::integer + 1));
    END IF;
    next_data := jsonb_set(next_data, '{version}', to_jsonb((next_data->>'version')::integer + 1));
    UPDATE workspaces SET data=next_data, updated_at=now() WHERE id=row.id;
  END LOOP;
END $$;

-- Plugin-wide routing must still have one destination for an App/repository.
-- Disable conflicting workspaces deterministically, preserving their saved workflow settings.
UPDATE workspaces later
SET data=jsonb_set(jsonb_set(jsonb_set(later.data, '{reviewBot,settings,enabled}', 'false'),
  '{reviewBot,revision}', to_jsonb((later.data#>>'{reviewBot,revision}')::integer + 1)),
  '{version}', to_jsonb((later.data->>'version')::integer + 1)), updated_at=now()
WHERE later.data#>>'{reviewBot,settings,enabled}'='true' AND NOT later.data ? 'deletion'
  AND EXISTS (
    SELECT 1 FROM workspaces earlier
    WHERE earlier.id < later.id AND NOT earlier.data ? 'deletion'
      AND earlier.data->>'operatorId'=later.data->>'operatorId'
      AND earlier.data#>>'{github,installationId}'=later.data#>>'{github,installationId}'
      AND earlier.data#>>'{reviewBot,settings,enabled}'='true'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(earlier.data#>'{github,repositories}') a,
        jsonb_array_elements(later.data#>'{github,repositories}') b WHERE a->>'id'=b->>'id')
  );
