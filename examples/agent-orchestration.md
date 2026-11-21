# Agent Orchestration & Autonomy Examples

Runnable HTTP requests and natural-language Telegram examples for Telo's
orchestration, autonomy presets, proactive automations, and per-repository queues.

## 1. Configure Workspace and Repository Autonomy (Admin API)

```bash
# Inspect current autonomy policy
curl -sS -b cookies.txt \
  "http://127.0.0.1:3000/api/admin/workspaces/${WORKSPACE_ID}/autonomy"

# Switch workspace default to Check-in (L3 gates remain mandatory)
curl -sS -X PATCH -b cookies.txt \
  -H "Content-Type: application/json" \
  -H "Origin: http://127.0.0.1:3000" \
  -H "X-CSRF-Token: ${CSRF}" \
  -d '{"revision":0,"defaultMode":"check_in"}' \
  "http://127.0.0.1:3000/api/admin/workspaces/${WORKSPACE_ID}/autonomy"

# Override a sensitive production repository back to Supervised
curl -sS -X PATCH -b cookies.txt \
  -H "Content-Type: application/json" \
  -H "Origin: http://127.0.0.1:3000" \
  -H "X-CSRF-Token: ${CSRF}" \
  -d '{"revision":1,"mode":"supervised"}' \
  "http://127.0.0.1:3000/api/admin/workspaces/${WORKSPACE_ID}/github/repositories/${REPO_ID}/autonomy"
```

## 2. Inspect and Cancel Background Missions

```bash
# List missions
curl -sS -b cookies.txt \
  "http://127.0.0.1:3000/api/admin/workspaces/${WORKSPACE_ID}/missions"

# Inspect mission waits and verified artifacts
curl -sS -b cookies.txt \
  "http://127.0.0.1:3000/api/admin/workspaces/${WORKSPACE_ID}/missions/${MISSION_ID}"

# Cancel an active or waiting mission
curl -sS -X POST -b cookies.txt \
  -H "Origin: http://127.0.0.1:3000" \
  -H "X-CSRF-Token: ${CSRF}" \
  "http://127.0.0.1:3000/api/admin/workspaces/${WORKSPACE_ID}/missions/${MISSION_ID}/cancel"
```

## 3. Manage Per-Repository Task Queues

```bash
# List all repository queues
curl -sS -b cookies.txt \
  "http://127.0.0.1:3000/api/admin/workspaces/${WORKSPACE_ID}/queues"

# Pause or resume a repository queue
curl -sS -X POST -b cookies.txt \
  -H "Origin: http://127.0.0.1:3000" \
  -H "X-CSRF-Token: ${CSRF}" \
  "http://127.0.0.1:3000/api/admin/workspaces/${WORKSPACE_ID}/queues/${REPO_ID}/pause"

# Pin a queued item to run next
curl -sS -X POST -b cookies.txt \
  -H "Origin: http://127.0.0.1:3000" \
  -H "X-CSRF-Token: ${CSRF}" \
  "http://127.0.0.1:3000/api/admin/workspaces/${WORKSPACE_ID}/queues/${REPO_ID}/items/${ITEM_ID}/pin"
```

## 4. Natural-Language Telegram Requests

- **Multi-step implicit orchestration:**
  > "Check if last week's landing page change caused the Search Console drop; if so, open a draft fix PR, record the findings in Obsidian, and tell me once CI passes."
- **One-shot reminder:**
  > "Check PR #42 CI status tomorrow at 10:00 Asia/Taipei once."
- **Silent Watcher:**
  > "Every 60 minutes (quiet from 23:00 to 07:00 Asia/Taipei), check acme/backend error alerts and only message me if something fails."
- **GitHub event automation:**
  > "Whenever main CI fails on acme/backend, run a read-only root-cause summary here."
