# Automatic code review with Review Bot

Review Bot reviews PRs in connected GitHub repositories, answers questions in
comments and makes explicitly requested fixes in the same PR. It uses the existing
GitHub App, Codex runner and model credentials; no separate bot registration is
required.

## Prerequisites

- Connect the [GitHub App and target repositories](github.md).
- Enable [Codex](codex.md) with a working runner, task image and model credentials.
- Give RepoDesk a public HTTPS address so GitHub can deliver webhooks.

The default task image includes Open Code Review. Custom task images must retain
this tool; reviews fail explicitly when it is missing.

## Enable reviews as an administrator

1. Open **Plugins → Review Bot**.
2. Check **Webhook secret**. Apps created through current RepoDesk versions usually
   have it saved. If an older App has no secret, configure or generate one and set
   the same value in GitHub.
3. In the GitHub App webhook settings, verify the displayed URL, secret and enabled
   status. Subscribe to `pull_request`, `issue_comment` and
   `pull_request_review_comment`.
4. Use **Configuration → Edit** to configure automatic reviews, comment requests,
   explicitly requested fixes and the review model. Save, then enable the plugin.

New Apps created on a public HTTPS site have their webhook settings prefilled. If
the App was created using localhost, replace the inactive placeholder with the
public address when going live. Saving a secret in RepoDesk does not update GitHub.

Configuration applies to the whole plugin, with no additional repository list.
Avoid enabling Review Bot for the same App and repository in multiple workspaces
so event routing remains unambiguous.

## Automatic reviews

Opening or reopening a PR, pushing new commits and marking a draft ready for
review trigger automatic reviews. Draft PRs are skipped. New commits supersede
unfinished automatic reviews of older commits. Closing a PR cancels pending work.

The result is an informational review pinned to a specific commit, with a summary
and findings linked to relevant locations. It does not replace human approval or
automatically merge the PR. Check which files were reviewed, skipped or unavailable;
an empty findings list does not prove that the PR has no defects.

The summary separates **Standards** and **Spec**. Standards covers repository
rules, correctness and maintainability; Spec checks the originating requirements
for missing, partial, incorrect or out-of-scope behavior. When no usable spec is
available, Spec is marked skipped and Standards continues. A passing assessment on
one axis does not imply that the other passes.

Review instructions call for checking relevant callers, documentation and tests,
and comparing the previous implementation for regressions. Documented rule and
requirement violations should cite their source. Design concerns labeled
"Possible" are advisory; documented repository choices take precedence. Findings
retain their axis label, with severity ordering and duplicates combined within
each axis. Reviews return up to 20 findings and should disclose omissions per axis.
Missing tests or unsupported personal style preferences alone do not qualify as
findings. These instructions guide the model and do not guarantee review quality.

Automatic reviews use the App installation grant enabled by an administrator.
Member comment requests additionally check membership and GitHub permissions.

## Use GitHub comments

Use the actual App bot name displayed on the plugin page. Here, `repodesk` is only
an example:

| Comment | Result |
| --- | --- |
| `@repodesk[bot] review` | Review the current PR |
| `@repodesk[bot] explain this finding` | Explain a finding |
| `@repodesk[bot] fix this` | Implement the explicit request, run checks and update the same PR |
| `@repodesk[bot] status` | Show confirmed status |
| `@repodesk[bot] cancel` | Request cancellation of active work |

The short form `@repodesk` is also supported. Put the mention at the start of a
line. Mentions inside code blocks or quotes cannot authorize work. Replies to
inline findings can use the original review comment as reference context.

Comment authors must be active members, have verified their GitHub identity through
Telegram `/github` and have current repository read access. Fixes require write
access and administrator enablement of requested fixes. Ordinary questions remain
read-only. When clarification is necessary, the original requester can continue by
replying with another mention.

Reviews and ordinary questions only read files, diffs and review rules at the
commits pinned to the task. They do not execute repository scripts or tests.
Unavailable files are disclosed as coverage gaps rather than counted as reviewed.

## Fix scope

PRs within the same repository support updating the original branch after checks.
Fork PRs support reviews and answers. Explicit fix requests can start work without
another development approval click; they do not authorize merging or deployment.

If another maintainer pushes updates, unpublished work rechecks the current code
to avoid overwriting new commits. Check GitHub before retrying when publication
has an unknown outcome. Cancellation, revoked access and workspace deletion do not
retract comments or commits already published.

If no result arrives, check GitHub webhook deliveries, plugin status, member
verification and runner status. See [Troubleshooting](troubleshooting.md).
