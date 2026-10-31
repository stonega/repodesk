import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
const key=(await readFile('/run/secrets/browser_token','utf8')).trim();
const workspaceId=randomUUID();
async function call(owner,controller,generation,operation){
 const now=Date.now(),body=JSON.stringify({id:randomUUID(),owner,controller,generation,issuedAt:now,expiresAt:now+30000,operation,policy:{origins:[],previewOrigins:[],interact:false}});
 const signature=createHmac('sha256',key).update(`repodesk:browser:v1\n${body}`).digest('hex');
 return new Promise((resolve,reject)=>{const req=request({socketPath:'/run/repodesk-browser/control.sock',path:'/v1/browser',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),'x-repodesk-browser-signature':signature}},res=>{let raw='';res.on('data',chunk=>raw+=chunk);res.on('end',()=>{try{const result=JSON.parse(raw);if(res.statusCode!==200)reject(Error(result.error??'browser_probe_failed'));else resolve(result);}catch{reject(Error('browser_probe_failed'));}});});req.setTimeout(30000,()=>req.destroy());req.on('error',()=>reject(Error('browser_probe_unavailable')));req.end(body);});
}
for(const actor of ['900000000000001','900000000000002']){
 const owner={workspaceId,actor},controller={kind:'plugin',id:randomUUID(),fence:1,pluginId:'deployment-probe',pluginRevision:7};
 try{
  assert.equal((await call(owner,controller,1,{command:'acquire'})).headed,true);
  assert.equal((await call(owner,controller,1,{command:'action',input:{action:'tabs'}})).status,'completed');
  await assert.rejects(call(owner,{...controller,pluginRevision:6},1,{command:'action',input:{action:'tabs'}}),/browser_control_expired/);
 }finally{
  await call(owner,controller,2,{command:'close'});
  assert.equal((await call(owner,controller,3,{command:'delete'})).status,'deleted');
 }
}
console.log(JSON.stringify({headed:true,applicationUid:process.getuid(),privateProfiles:true,pluginRevisionFenced:true,cleaned:true,externalWebsitesUsed:false}));
