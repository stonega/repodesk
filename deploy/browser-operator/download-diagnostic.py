"""Read-only diagnosis of the four verified runs in the reported private Topic."""

import json
import subprocess

script = r'''
import { Pool } from 'pg';
import { createHash, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
const pool = new Pool({connectionString:process.env.DATABASE_URL});
const workspaceId = '3b2dfe82-61c6-444e-8058-7a179f2bf27a';
const actorHash = actor => createHash('sha256').update(actor).digest('hex').slice(0,12);
const runIds = new Set(['a2fcf7d7-7d37-4d50-bd04-1820e41670fb','2933f58d-c8e5-4b5f-9c3e-affacaad824d',
  '92c9022b-08cd-43dd-9e1a-5118a7a04551','a676942b-bf6a-41e7-8f92-654617acbb5d']);
const origin = value => {try{return new URL(value).origin}catch{return undefined}};
const codes = value => [...new Set(JSON.stringify(value??'').match(/\bbrowser_[a-z_]+\b/g)??[])];
const action = value => ({action:value?.action,origin:origin(value?.url),requireApproval:value?.requireApproval,
  selector:typeof value?.selector==='string' && /^#[a-zA-Z0-9_-]{1,80}$/.test(value.selector)?value.selector:undefined});
const resultSummary = value => {
  let result=value;
  const content=value?.content?.find(c=>c.type==='text')?.text;
  if(content){try{result=JSON.parse(content)}catch{result={};}}
  return {status:result?.status,code:result?.code,codes:codes(value),page:result?.page,
    requestId:result?.requestId,blockedOrigins:result?.blockedOrigins,
    controls:result?.controls?.map(c=>({role:c.role,type:c.type,selector:action(c).selector})),
    downloads:result?.downloads?.map(d=>({id:d.id,size:d.size})),reference:result?.reference,
    publicPageMarkers:['Download','download','Search','search','Loading','loading','error','failed','captcha','CAPTCHA','YouTube','video'].filter(s=>result?.text?.includes(s))};
};
const unseal = (key,aad,ciphertext) => {
  const [version,iv,tag,data]=ciphertext.split('.');
  const cipher=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(iv,'base64'));
  cipher.setAAD(Buffer.from(`${version==='v1'?'deepx:v1':'repodesk:v2'}:${aad}`));
  cipher.setAuthTag(Buffer.from(tag,'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data,'base64')),cipher.final()]));
};
try {
  await pool.query('BEGIN READ ONLY');
  await pool.query("SET LOCAL statement_timeout='10s'");
  const {rows} = await pool.query('SELECT id,data FROM workspaces WHERE id=$1 AND NOT(data ? \'deletion\')',[workspaceId]);
  for (const {id,data:w} of rows) {
    const runs = (w.runs??[]).filter(r=>runIds.has(r.id) && actorHash(r.actor)==='203155609b2b' && r.topicId===1995876);
    const ids = new Set(runs.map(r=>r.id));
    const key=readFileSync(process.env.ENCRYPTION_KEY_FILE,'utf8').trim();
    for(const r of runs) if(r.browserSealed) Object.assign(r,unseal(key,`browser-content:${id}:${r.actor}:run:${r.id}`,r.browserSealed));
    console.log(JSON.stringify({workspaceId:id,browserEnabled:w.plugins?.browser?.enabled??true,
      runs:runs.map(r=>({id:r.id,actorHash:actorHash(r.actor),topicId:r.topicId,status:r.status,
        at:r.at,finishedAt:r.finishedAt,error:r.error,cancelled:r.cancelled,fence:r.fence,
        intent:{snapyt:/snapyt\.app/i.test(r.task),progress:/progress|進度|进度/i.test(r.task),
          continuation:/continue/i.test(r.task),retry:/retry|重試|重试/i.test(r.task)},
        browserWait:r.browserWait?{id:r.browserWait.id,kind:r.browserWait.kind,expiresAt:r.browserWait.expiresAt}:undefined,
        browserResumed:r.browserResumed,
        transcript:(r.transcript??[]).map((m,index)=>({index,role:m.role,at:m.timestamp,
          ...(m.role==='toolResult'?{name:m.toolName,callId:m.toolCallId,result:resultSummary(m)}:{}),
          ...(m.role==='assistant'?{tools:m.content?.filter(c=>c.type==='toolCall').map(c=>({name:c.name,id:c.id,...action(c.arguments)}))}:{} )})),
        tools:Object.entries(r.tools??{}).map(([callId,t])=>({callId,name:t.name,state:t.state,result:resultSummary(t.result)}))})),
      deliveries:(w.deliveries??[]).filter(d=>ids.has(d.runId)).map(d=>({id:d.id,runId:d.runId,
        state:d.state,at:d.at,attempts:d.attempts,browserRequest:d.browserRequest,
        browserResume:d.browserResume,topicId:d.topicId}))}));
    const actor=runs[0]?.actor;
    if(actor){
      const {rows:profiles}=await pool.query('SELECT data,updated_at FROM browser_profiles WHERE workspace_id=$1 AND actor=$2',[id,actor]);
      for(const p of profiles){
        const ownerHash=createHash('sha256').update(JSON.stringify({actor,workspaceId:id})).digest('hex');
        const state=unseal(key,`browser:${ownerHash}`,p.data);
        console.log(JSON.stringify({profile:{updatedAt:p.updated_at,generation:state.generation,epoch:state.epoch,
          lease:state.lease,sites:state.access?.sites,
          requests:state.access?.requests?.filter(q=>ids.has(q.controller.id)).map(q=>({id:q.id,controller:q.controller,
            kind:q.kind,state:q.state,origin:q.origin,expiresAt:q.expiresAt,startedAt:q.startedAt,
            generation:q.generation,page:q.page,action:action(q.action),result:resultSummary(q.result),resumePending:q.resumePending})),
          operations:state.operations?.slice(-30).map(o=>({id:o.id,state:o.state,generation:o.generation,result:o.result}))}}));
      }
    }
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
