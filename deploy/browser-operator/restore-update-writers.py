"""Recover the exact, unchanged writers when an update stops before native install."""
import json, re, subprocess, sys, time
from pathlib import Path
bundle=Path(sys.argv[1]).resolve()
assert re.fullmatch(r'[0-9]+-[0-9]+',bundle.name)
assert bundle.parent==Path('/opt/repodesk/releases')
meta=json.loads((bundle/'source-metadata.json').read_text())
assert Path('/opt/repodesk/.current-release').read_text().strip()==meta['previous_release_id']
assert (bundle/'stage').read_text().strip() in ['wait_for_browser_and_coding_checkpoints','verify_existing_configuration_and_secret_bindings']
assert not (bundle/'cutover.log').exists()
before=json.loads((bundle/'baseline.json').read_text())
for name in ['repodesk-app-1','repodesk-worker-1']:
 expected=before['containers'][name]
 actual=json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]
 assert actual['Id']==expected['id'] and actual['Image']==expected['image']
 if actual['State']['Status']!='running':
  subprocess.run(['docker','start',expected['id']],check=True,stdout=subprocess.DEVNULL)
deadline=time.monotonic()+180
while time.monotonic()<deadline:
 statuses={}
 for name in ['repodesk-app-1','repodesk-worker-1']:
  actual=json.loads(subprocess.check_output(['docker','inspect',name],text=True))[0]
  statuses[name]=actual['State'].get('Health',{}).get('Status',actual['State']['Status'])
 if all(value=='healthy' for value in statuses.values()):
  print(json.dumps({'previous_writers_restored':True,'services':statuses}));break
 time.sleep(3)
else:raise RuntimeError('previous_writers_not_healthy')
