# Compare PR code and review evidence

Local implementation, 2026-10-17. Use a test workspace with a connected GitHub App
installation, selected repository and an active member who has repository read
access. A private repository requires a private bot conversation for ad-hoc reads.
The installation needs Pull requests read access; the configured write grant
already includes it. Deploy the updated app and worker before this live journey.

Send in Telegram:

```text
Compare the implementations in example/workspace PR #2 and PR #3.
Read their changed files and diffs, then explain any review findings.
Distinguish actual code differences from PR descriptions and missing evidence.
```

The assistant resolves the selected repository, reads each PR separately through
`query_github_pull_request`, and cites the PR links, paths and relevant commits.
It uses `resource: files` for patches, `reviews` for review states/bodies and
`comments` for inline discussions. Expected tool input after repository resolution:

```json
{"repositoryId":7001,"number":2,"resource":"files","page":1}
```

When `nextPage` is present, use the same resource and the returned commit pins:

```json
{"repositoryId":7001,"number":2,"resource":"files","page":2,"headSha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","baseSha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}
```

Those SHAs are illustrative; use the actual returned values. Reuse them when
reading reviews/comments at page 1. If the head or base changed, restart from page
1 and reread the affected evidence. Explain binary/missing patches, excerpt
truncation and any remaining pages rather than claiming a complete code review.
Review records include their own commits; an older approval does not establish
current merge readiness or CI success. Inline comments exclude general PR
conversation comments. No GitHub mutation or coding task should be proposed.

For an actual missing installation permission, the returned guidance identifies
Pull requests read access and installation acceptance. A generic denied read
requires checking both installation selection/permissions and requester access.
Returning only titles/body from `query_github_metadata` does not diagnose a
permission failure: use the registered detail tool.

Credential-free deterministic checks, with disposable PostgreSQL:

```sh
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55439/postgres \
  bun test tests/integration/github-pull-request-details.test.ts \
  tests/integration/team-workflows.test.ts tests/integration/github-pull-requests.test.ts
```

The suite covers different patches for two PRs, scoped read tokens, pagination,
the file/API cap, missing/truncated text, review provenance, input validation,
tenant/member/private-group boundaries, revocation during every network stage,
changing commits, malformed responses and actual Pi tool registration/guidance.
