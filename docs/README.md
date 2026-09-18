# Product documentation

Research date: **2026-09-18**. Working product name: **DeepX Agent**.

This is a Telegram adaptation of the team-workflow concept behind Every Agent.
It is not affiliated with Every. Feature parity is a research input, not a claim
that all features already exist or should ship together.

| Document | Purpose |
| --- | --- |
| [Every Agent feature inventory](research/every-agent-features.md) | Detailed public features, evidence strength, pricing conflict, and unknowns |
| [Source register](reference/sources.md) | URLs, retrieval method, scope, and research limitations |
| [Product requirements](design/product-requirements.md) | Proposed features, priorities, acceptance criteria, permissions, and success measures |
| [Telegram platform constraints](reference/telegram-platform.md) | What changes when Slack becomes Telegram |
| [Architecture](design/architecture.md) | Implemented scaffold versus proposed production system |
| [Admin panel](design/admin-panel.md) | P0 configuration screens, permissions, APIs and acceptance criteria |
| [First-run setup](design/first-run-setup.md) | Initial admin creation, bot onboarding, secrets and activation |
| [Agent skills](design/agent-skills.md) | Web-managed catalog, settings, versioning and Pi integration |
| [Allowed-user whitelist](design/access-control.md) | Configurable access, admin controls, enforcement and revocation |
| [Pi + Docker implementation plan](implementation/bot-plan.md) | Concrete engineering tasks, architecture decisions, tests and rollout |
| [Roadmap](implementation/roadmap.md) | Dependency-ordered milestones and release gates |
| [Setup](implementation/setup.md) | Local commands, validation, and future configuration |
| [Telegram experience](user/telegram-experience.md) | Proposed commands, onboarding, and example conversations |

## Evidence vocabulary

- **Documented:** explicitly described in public product pages; not independently tested.
- **Demonstrated:** shown in a marketing example; not proof of complete integration support.
- **Policy-disclosed:** named in privacy/terms material; not proof of a generally available UI.
- **Inferred:** a plausible interpretation with no explicit product commitment.
- **Proposed:** our own design decision or requirement.
- **Implemented:** present in this repository and checked locally.

Only the HTTP scaffold and development tooling are implemented. All product
requirements and user flows are proposals unless a later implementation milestone
explicitly changes their status.
