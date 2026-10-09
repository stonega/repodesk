# Product documentation

Research baseline: **2026-09-18**; Every Agent public launch follow-up: **2026-10-07**.
Product name: **RepoDesk**.

RepoDesk's main journey is working with selected GitHub repositories from Telegram,
with AI helping interpret questions and draft scoped actions. Start with
[GitHub work through Telegram](design/github-workflows.md). The earlier team-workflow
research was inspired by Every Agent; RepoDesk is not affiliated with Every.
Competitor feature parity is neither a goal nor an implementation claim.

| Document | Purpose |
| --- | --- |
| [Every Agent feature inventory](research/every-agent-features.md) | September baseline, October launch update, RepoDesk feature recommendations, evidence strength and unknowns |
| [Source register](reference/sources.md) | URLs, retrieval method, scope, and research limitations |
| [Product requirements](design/product-requirements.md) | Proposed features, priorities, acceptance criteria, permissions, and success measures |
| [GitHub work through Telegram](design/github-workflows.md) | Main user journey, current GitHub capabilities, boundaries and next decisions |
| [Telegram image and attachment input](implementation/telegram-attachments.md) | Implemented formats, download controls, media budgets and limits |
| [Telegram platform constraints](reference/telegram-platform.md) | What changes when Slack becomes Telegram |
| [Private conversation threads](design/private-threads.md) | Native Topics, discussion memory, cache-aware compaction and private history |
| [Group conversations](design/group-conversations.md) | Per-user continuity, shared discussions and natural follow-up triggering |
| [Architecture](design/architecture.md) | Implemented local pilot and production boundaries |
| [Admin panel](design/admin-panel.md) | P0 configuration screens, permissions, APIs and acceptance criteria |
| [UI rules](design/ui-rules.md) | User design preferences, their scope, and how to apply and maintain them |
| [First-run setup](design/first-run-setup.md) | Initial admin creation, bot onboarding, secrets and activation |
| [LLM extensions / plugins](design/llm-extensions.md) | Existing Pi extension loading, headless compatibility, grants and recovery |
| [Agent skills](design/agent-skills.md) | Web-managed catalog, settings, versioning and Pi integration |
| [Workspace membership and access](design/access-control.md) | Active membership, roles, enforcement and revocation |
| [Pi + Docker implementation plan](implementation/bot-plan.md) | Concrete engineering tasks, architecture decisions, tests and rollout |
| [Roadmap](implementation/roadmap.md) | Dependency-ordered milestones and release gates |
| [Repository reports, skills and handoffs](implementation/team-workflows-plan.md) | Accepted R01–R03 plan, permission contracts, implementation and verification |
| [Telegram feedback beta plan](implementation/telegram-feedback-plan.md) | Readable progress, task status, cancellation and failures for friends and colleagues |
| [GitHub App connections](implementation/github-app.md) | Default GitHub tools/skill, App registration, repository connections, permissions and approved PR actions |
| [Review Bot](implementation/review-bot.md) | Selected-repository automatic PR reviews and tagged same-PR work |
| [Codex coding tasks](implementation/codex-coding.md) | Maintainer-only issue-to-PR tasks, repository settings and local runner setup |
| [Continuous Codex collaboration](design/codex-collaboration.md) | Policy-gated continuous tasks: Pi requirements intake, Codex decisions, Telegram questions, repair and same-PR follow-ups; live pilot pending |
| [Codex collaboration implementation plan](implementation/codex-collaboration-plan.md) | Protocol proof, durable tasks, original-requirement handoff, Telegram input, repair, same-PR continuation and release gates |
| [Codex account authentication lifecycle](implementation/codex-auth-plan.md) | Credential generations, automatic refresh persistence, sign-in pauses and authorized continuation |
| [Local Codex runner](implementation/codex-podman.md) | Automatic Docker VPS runner, Podman isolation, account auth and local publication |
| [Local Code Truth](implementation/code-truth.md) | Predefined source-query extension, local MCP service and repository configuration |
| [Setup](implementation/setup.md) | Local commands, validation, and configuration |
| [Implementation evidence](implementation/implementation-status.md) | Verified behavior and remaining live release gates |
| [Release runbook](implementation/release-runbook.md) | Staging demonstration, backup/restore and recovery |
| [VPS release deployment](implementation/vps-deployment.md) | GitHub Release workflow, SSH secrets, host provisioning and failure recovery |
| [Self-hosted Actions runner](implementation/self-hosted-runner.md) | VPS runner installation, separate CI Docker daemon, registration and operations |
| [Debugging](implementation/debugging.md) | Operator-provided VPS access and missing-reply diagnosis |
| [Telegram experience](user/telegram-experience.md) | Proposed commands, onboarding, and example conversations |

## Evidence vocabulary

- **Documented:** explicitly described in public product pages; not independently tested.
- **Demonstrated:** shown in a marketing example; not proof of complete integration support.
- **Policy-disclosed:** named in privacy/terms material; not proof of a generally available UI.
- **Inferred:** a plausible interpretation with no explicit product commitment.
- **Proposed:** our own design decision or requirement.
- **Implemented:** present in this repository and checked locally.

The local bot, Pi worker, PostgreSQL state, setup wizard, admin panel and bounded
GitHub paths are implemented.
Read [implementation evidence](implementation/implementation-status.md) for verified
scope, limits and outstanding live release gates. Competitor claims remain research;
P1/P2 features remain proposals. No public deployment is implied.
