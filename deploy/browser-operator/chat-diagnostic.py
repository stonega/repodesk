"""Read-only, time-scoped Browser task metadata; no private bodies or credentials."""

import json
import subprocess

script = r'''
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
const pool = new Pool({connectionString:process.env.DATABASE_URL});
const workspaceId = '3b2dfe82-61c6-444e-8058-7a179f2bf27a';
const actorHash = actor => createHash('sha256').update(actor).digest('hex').slice(0,12);
const inWindow = r => (r.at >= '2026-11-01T00:20:00' && r.at < '2026-11-01T01:00:00') ||
  (r.at >= '2026-11-04T02:30:00' && r.at < '2026-11-04T04:00:00');
try {
  await pool.query('BEGIN READ ONLY');
  await pool.query("SET LOCAL statement_timeout='10s'");
  const {rows} = await pool.query('SELECT id,data FROM workspaces WHERE id=$1 AND NOT(data ? \'deletion\')',[workspaceId]);
  for (const {id,data:w} of rows) {
    const runs = (w.runs??[]).filter(r=>inWindow(r) && (r.browserRead || r.browserWait)).slice(-30);
    const ids = new Set(runs.map(r=>r.id));
    console.log(JSON.stringify({workspaceId:id,browserEnabled:w.plugins?.browser?.enabled??true,
      runs:runs.map(r=>({id:r.id,actorHash:actorHash(r.actor),topicId:r.topicId,status:r.status,
        at:r.at,finishedAt:r.finishedAt,error:r.error,cancelled:r.cancelled,fence:r.fence,
        browserWait:r.browserWait,browserResumed:r.browserResumed,privateBodySealed:!!r.browserSealed,
        attempts:r.attempts?.map(a=>({id:a.id,state:a.state,at:a.at,finishedAt:a.finishedAt}))})),
      deliveries:(w.deliveries??[]).filter(d=>ids.has(d.runId)).map(d=>({id:d.id,runId:d.runId,
        state:d.state,at:d.at,attempts:d.attempts,browserRequest:d.browserRequest,
        browserResume:d.browserResume,topicId:d.topicId}))}));
    const {rows:events} = await pool.query("SELECT at,event,code,run_id FROM runtime_logs WHERE workspace_id=$1 AND run_id::text=ANY($2::text[]) ORDER BY at DESC LIMIT 120",[id,[...ids]]);
    console.log(JSON.stringify({runtime:events}));
  }
  await pool.query('ROLLBACK');
} catch(error) {
  console.log(JSON.stringify({diagnosticCode:'browser_task_metadata_failed',
    databaseCode:typeof error.code==='string' && /^[0-9A-Z]{5}$/.test(error.code)?error.code:undefined}));
  process.exitCode=1;
} finally {await pool.end();}
'''

result = subprocess.run(
    ["docker", "exec", "-i", "repodesk-app-1", "node", "--input-type=module"],
    input=script,
    text=True,
    capture_output=True,
    timeout=45,
)
print(result.stdout, end="")
if result.returncode:
    print(json.dumps({"diagnosticCode": "browser_task_metadata_failed", "exit": result.returncode}))
    raise SystemExit(1)
