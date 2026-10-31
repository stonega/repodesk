import json, subprocess, hashlib, sys, os
from pathlib import Path
root=Path('/opt/repodesk')
containers=json.loads(subprocess.check_output(['docker','ps','-aq'],text=True).strip() and subprocess.check_output(['docker','inspect',*subprocess.check_output(['docker','ps','-aq'],text=True).split()],text=True) or '[]')
selected={}
for c in containers:
    name=c['Name'].removeprefix('/')
    if name not in ['repodesk-app-1','repodesk-worker-1','repodesk-codex-runner-1','repodesk-code-truth-1','repodesk-postgres-1'] and not name.startswith('repodesk-actions-runner-'):
        continue
    selected[name]={'id':c['Id'],'image':c['Image'],'status':c['State']['Status'],'health':c['State'].get('Health',{}).get('Status'),'started_at':c['State']['StartedAt'],'mounts':[{k:m.get(k) for k in ['Type','Name','Source','Destination']} for m in c['Mounts']]}
secrets={}
for relative in ['.env','secrets/encryption-key','secrets/codex-runner-token']:
    path=root/relative
    secrets[relative]=hashlib.sha256(path.read_bytes()).hexdigest()
result={'release_id':(root/'.current-release').read_text().strip(),'containers':selected,'secret_hashes':secrets}
path=Path(sys.argv[1])
path.write_text(json.dumps(result,indent=2)+'\n')
os.chmod(path,0o600)
print(json.dumps({'release_id':result['release_id'],'containers':{name:{'status':value['status'],'health':value['health']} for name,value in selected.items()},'protected_baseline_saved':True}))
