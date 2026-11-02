"""Read only incident-scoped metadata; never print message bodies or credentials."""
import json, re, subprocess

script = r'''
import {Pool} from 'pg';
import {readFileSync} from 'node:fs';
import {createDecipheriv,createHash} from 'node:crypto';
const pool=new Pool({connectionString:process.env.DATABASE_URL});
const text=(v)=>JSON.stringify(v??'');
const codes=(v)=>[...new Set(text(v).match(/\b(?:browser_[a-z_]+|code_truth_[a-z_]+|github_[a-z_]+|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|unavailable)\b/g)??[])];
const summary=(m)=>({role:m.role,toolName:m.toolName,toolCallId:m.toolCallId,isError:m.isError,codes:codes(m),tools:(m.content??[]).filter?.(c=>c.type==='toolCall').map(c=>({name:c.name,id:c.id,action:c.arguments?.action,url:c.arguments?.url,target:c.arguments?.target,network:c.arguments?.network}))});
try{
 const rows=await pool.query("SELECT id,data FROM workspaces WHERE data::text LIKE '%street-polls%' AND NOT(data ? 'deletion')");
 for(const row of rows.rows){
  const w=row.data;
  const runs=(w.runs??[]).filter(r=>text(r).includes('mdddj')||text(r).includes('browser_service_unavailable')).slice(-12);
  const runIds=new Set(runs.map(r=>r.id));
  console.log(JSON.stringify({workspaceId:row.id,plugins:Object.fromEntries(['browser','codeTruth'].map(k=>[k,w.plugins?.[k]])),runs:runs.map(r=>({id:r.id,status:r.status,createdAt:r.createdAt,updatedAt:r.updatedAt,startedAt:r.startedAt,completedAt:r.completedAt,error:r.error,actor:r.actor,keys:Object.keys(r),messages:(r.transcript??[]).map(summary)}))}));
  const logs=await pool.query("SELECT at,event,code,run_id FROM runtime_logs WHERE workspace_id=$1 AND at>now()-interval '6 hours' ORDER BY id DESC LIMIT 80",[row.id]);console.log(JSON.stringify({runtime:logs.rows}));
  const key=readFileSync(process.env.ENCRYPTION_KEY_FILE,'utf8').trim();
  const profiles=await pool.query('SELECT workspace_id,actor,data,updated_at FROM browser_profiles WHERE workspace_id=$1',[row.id]);
  for(const p of profiles.rows){
   const owner={actor:p.actor,workspaceId:p.workspace_id};const hash=createHash('sha256').update(JSON.stringify(owner)).digest('hex');
   const [v,iv,tag,data]=p.data.split('.');const d=createDecipheriv('aes-256-gcm',Buffer.from(key,'hex'),Buffer.from(iv,'base64'));d.setAAD(Buffer.from(`repodesk:v2:browser:${hash}`));d.setAuthTag(Buffer.from(tag,'base64'));const state=JSON.parse(Buffer.concat([d.update(Buffer.from(data,'base64')),d.final()]));
   console.log(JSON.stringify({browserProfile:{workspaceId:p.workspace_id,actorHash:createHash('sha256').update(p.actor).digest('hex').slice(0,12),updatedAt:p.updated_at,generation:state.generation,epoch:state.epoch,lease:state.lease,sites:state.access?.sites,requests:state.access?.requests?.slice(-12).map(q=>({id:q.id,kind:q.kind,origin:q.origin,state:q.state,controller:q.controller,expiresAt:q.expiresAt,result:q.result?{status:q.result.status,code:q.result.code}:undefined}))}}));
  }
 }
}catch(e){console.log(JSON.stringify({diagnosticError:e.code??e.name}));process.exitCode=1}finally{await pool.end()}
'''
r = subprocess.run(['docker','exec','-i','repodesk-app-1','node','--input-type=module'], input=script, text=True, capture_output=True)
print(r.stdout,end='')
if r.returncode: print(json.dumps({'code':'chat_diagnostic_failed','exit':r.returncode}))
logs=subprocess.run(['journalctl','-u','repodesk-browser','--since','2026-11-02 05:00:00 UTC','--no-pager','-o','cat'],text=True,capture_output=True,check=True)
for line in logs.stdout.splitlines():
 try:
  d=json.loads(line)
  if d.get('event')=='browser_host_failed': print(json.dumps({k:d[k] for k in ['event','code','workspaceId','controllerId','requestId'] if k in d}))
 except ValueError: pass
print(subprocess.check_output(['systemctl','is-active','repodesk-browser'],text=True).strip())
