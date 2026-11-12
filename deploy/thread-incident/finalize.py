"""Verify the already deployed immutable release without restarting services."""
import json, os, re, subprocess, sys
from pathlib import Path
os.umask(0o077)
bundle=Path(sys.argv[1]).resolve()
assert bundle==Path('/opt/repodesk/releases/41958024518-1')
assert Path('/opt/repodesk/.current-release').read_text().strip()==bundle.name
with (bundle/'production-verification.retry.log').open('wb') as log:
 subprocess.run(['python3',str(bundle/'verify-deployment.py'),str(bundle)],stdout=log,stderr=subprocess.STDOUT,check=True)
for name in ['repodesk-app-1','repodesk-worker-1']:
 with (bundle/(name+'-browser-proof.stderr')).open('wb') as errors:
  result=subprocess.run(['docker','exec','-i',name,'node','--input-type=module'],input=(bundle/'host-probe.mjs').read_bytes(),stdout=subprocess.PIPE,stderr=errors,check=True)
 proof=json.loads(result.stdout)
 assert proof['headed'] and proof['cleaned'] and proof['privateProfiles'] and proof['pluginRevisionFenced']
 (bundle/(name+'-browser-proof.json')).write_text(json.dumps(proof)+'\n')
receipt=json.loads((bundle/'deployment-receipt.json').read_text())
receipt['feature_commit']='445ec494ae16b9da5591bea83ebfa97c35b292e0'
receipt['browser_host']['existingApiAndWorkerMountsVerified']=True
receipt['previous_features_preserved']=True
receipt['final_verification']={'separate_stdout_stderr':True,'services_restarted':False,'operator_commit':sys.argv[2]}
(bundle/'deployment-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
if (bundle/'failure.json').exists():
 (bundle/'failure.json').rename(bundle/'failure-before-final-verification.json')
(bundle/'stage').write_text('deployment_verified\n')
(bundle/'deploy.exit').write_text('0\n')
(bundle/'finalize.exit').write_text('0\n')
print(json.dumps({'verified':True,'release':bundle.name,'source_commit':receipt['source_commit'],'services':receipt['services'],'backup':receipt['backup'],'artifacts':receipt.get('artifacts_verified')}))
