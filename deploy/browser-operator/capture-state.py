import json, subprocess, hashlib, sys, os
from pathlib import Path
root=Path('/opt/telo')
containers=json.loads(subprocess.check_output(['docker','ps','-aq'],text=True).strip() and subprocess.check_output(['docker','inspect',*subprocess.check_output(['docker','ps','-aq'],text=True).split()],text=True) or '[]')
selected={}
for c in containers:
    name=c['Name'].removeprefix('/')
    if name not in ['telo-app-1','telo-worker-1','telo-codex-runner-1','telo-code-truth-1','telo-postgres-1'] and not name.startswith('telo-actions-runner-'):
        continue
    selected[name]={'id':c['Id'],'image':c['Image'],'status':c['State']['Status'],'health':c['State'].get('Health',{}).get('Status'),'started_at':c['State']['StartedAt'],'mounts':[{k:m.get(k) for k in ['Type','Name','Source','Destination','RW','Propagation','Mode']} for m in c['Mounts']]}
secrets={}
for relative in ['.env','secrets/encryption-key','secrets/codex-runner-token','secrets/browser-token','/etc/telo/browser-token','/etc/telo/browser.env']:
    path=root/relative
    secrets[relative]=hashlib.sha256(path.read_bytes()).hexdigest()
result={'release_id':(root/'.current-release').read_text().strip(),'containers':selected,'secret_hashes':secrets}
path=Path(sys.argv[1])
path.write_text(json.dumps(result,indent=2)+'\n')
os.chmod(path,0o600)
print(json.dumps({'release_id':result['release_id'],'containers':{name:{'status':value['status'],'health':value['health']} for name,value in selected.items()},'protected_baseline_saved':True}))
