import hashlib,json,os,shutil,stat,subprocess,sys,time
from pathlib import Path
os.umask(0o077)
bundle=Path(sys.argv[1]);original=Path('/opt/repodesk/releases/41166151438-1');root=Path('/opt/repodesk')
def stage(value):(bundle/'stage').write_text(value+'\n')
def run(args,log,**kwargs):
 with (bundle/log).open('wb') as out:subprocess.run(args,stdout=out,stderr=subprocess.STDOUT,check=True,**kwargs)
def wait_socket():
 for attempt in range(120):
  try:
   s=Path('/run/repodesk-browser/control.sock').stat()
   if stat.S_ISSOCK(s.st_mode) and stat.S_IMODE(s.st_mode)==0o660 and s.st_gid==1000:return
  except FileNotFoundError:pass
  time.sleep(.25)
 raise RuntimeError('browser_host_socket_not_ready')
try:
 stage('verify_recovered_release_and_immutable_images')
 meta=json.loads((original/'source-metadata.json').read_text());assert (root/'.current-release').read_text().strip()==meta['previous_release_id']
 assert (original/'deploy.exit').read_text().strip()=='1'
 assert hashlib.sha256((original/'source.tar.gz').read_bytes()).hexdigest()==meta['source_sha256']
 for name,digest in json.loads((original/'payload-checksums.json').read_text()).items():assert hashlib.sha256((original/name).read_bytes()).hexdigest()==digest,name
 images=json.loads((original/'build-images.json').read_text())
 for item in images.values():assert subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',item['tag']],text=True).strip()==item['id']
 old_backup=root/'backups'/('pre-release-'+meta['release_id']+'.dump');assert old_backup.stat().st_size>0
 with old_backup.open('rb') as f:subprocess.run(['docker','exec','-i','repodesk-postgres-1','pg_restore','--list'],stdin=f,stdout=subprocess.DEVNULL,check=True)
 for name in ['image-tag','image-id','code-truth-tag','code-truth-id','codex-supervisor-tag','codex-supervisor-id','codex-job-tag','codex-job-id','codex-compose.yaml','codex-release-config.mjs','codex-wait-checkpoint.mjs','artifact-hashes.json','build-images.json','container-verification.json','source.tar.gz','capture-state.py','verify-deployment.py','host-probe.mjs','native-host-verification.json']:
  shutil.copyfile(original/name,bundle/name)
 os.chmod(bundle/'host-probe.mjs',0o644)
 meta['release_id']=bundle.name;meta['operator_commit']=(bundle/'operator-commit').read_text().strip();meta['verified_runtime_reused_from']=original.name
 (bundle/'source-metadata.json').write_text(json.dumps(meta,indent=2)+'\n')
 native=json.loads((bundle/'native-host-verification.json').read_text());assert native['headed'] and native['applicationUid']==1000 and native['cleaned']
 unit=Path('/etc/systemd/system/repodesk-browser.service.d/socket.conf');unit.write_text('[Service]\nRuntimeDirectoryPreserve=yes\n');os.chmod(unit,0o644)
 run(['systemctl','daemon-reload'],'socket-policy-reload.log')
 wait_socket()
 stage('capture_recovered_baseline_and_verify_service_secret_bindings')
 run(['python3',str(bundle/'capture-state.py'),str(bundle/'baseline.json')],'baseline.log')
 # The normal deployment script now probes migrate, app and worker secret access before stopping writers.
 stage('guarded_backup_migration_and_cutover')
 run(['bash',str(bundle/'deploy-vps.sh'),str(root),bundle.name,'repodesk','--local-images'],'cutover.log')
 stage('verify_live_images_assets_and_preserved_state')
 run(['python3',str(bundle/'verify-deployment.py'),str(bundle)],'production-verification.log')
 stage('verify_browser_restart_from_existing_api_and_worker_mounts')
 before=Path('/run/repodesk-browser').stat().st_ino
 run(['systemctl','restart','repodesk-browser'],'browser-restart.log');wait_socket()
 assert Path('/run/repodesk-browser').stat().st_ino==before
 for name in ['repodesk-app-1','repodesk-worker-1']:
  run(['docker','exec','-i',name,'node','--input-type=module'],name+'-browser-proof.json',input=(bundle/'host-probe.mjs').read_bytes())
  proof=json.loads((bundle/(name+'-browser-proof.json')).read_text());assert proof['headed'] and proof['applicationUid']==1000 and proof['cleaned']
 receipt=json.loads((bundle/'deployment-receipt.json').read_text());receipt['operational_finish_commit']=meta['operator_commit'];receipt['verified_runtime_reused_from']=original.name;receipt['compose_sha256']=hashlib.sha256((bundle/'compose.yaml').read_bytes()).hexdigest();receipt['browser_host'].update(socketDirectoryPreservedOnRestart=True,existingApiAndWorkerMountsVerified=True,socketUnitOverrideSha256=hashlib.sha256(unit.read_bytes()).hexdigest());(bundle/'deployment-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 stage('deployment_verified')
except Exception as error:
 (bundle/'failure.json').write_text(json.dumps({'stage':(bundle/'stage').read_text().strip(),'error':type(error).__name__,'message':str(error)})+'\n');stage('deployment_failed');raise
