import datetime,hashlib,json,os,shutil,subprocess,sys
from pathlib import Path
os.umask(0o077)
bundle=Path(__file__).resolve().parent
root=Path('/opt/repodesk')
source=bundle/'source'
meta=json.loads((bundle/'source-metadata.json').read_text())
def run(args,log,**kw):
 with (bundle/log).open('wb') as output: subprocess.run(args,stdout=output,stderr=subprocess.STDOUT,check=True,**kw)
def stage(name):
 (bundle/'stage').write_text(name+'\n'); print(name,flush=True)
def output(args):return subprocess.check_output(args,text=True).strip()
try:
 stage('verify_source_and_capture_baseline')
 assert root.is_dir() and (root/'.env').is_file()
 assert output(['id','-u'])=='0'
 assert output(['uname','-m'])=='x86_64'
 assert (root/'.current-release').read_text().strip()==meta['previous_release_id'],'Production release changed'
 for name,digest in json.loads((bundle/'payload-checksums.json').read_text()).items():
  assert hashlib.sha256((bundle/name).read_bytes()).hexdigest()==digest,'Payload mismatch: '+name
 assert hashlib.sha256((bundle/'source.tar.gz').read_bytes()).hexdigest()==meta['source_sha256']
 run(['python3',str(bundle/'capture-state.py'),str(bundle/'baseline.json')],'baseline.log')
 source.mkdir(mode=0o700)
 run(['tar','-xzf',str(bundle/'source.tar.gz'),'-C',str(source)],'source-extract.log')
 images={}
 for name,repository,target,context in [('app','repodesk','app',source),('job','repodesk-codex-job','codex-job',source),('supervisor','repodesk-codex-supervisor','codex-supervisor',source),('code_truth','repodesk-code-truth',None,source/'services/code-truth')]:
  stage('build_'+name)
  assert shutil.disk_usage(root).free>3*1024**3,'Disk headroom too low'
  tag=repository+':release-'+meta['source_commit']; args=['docker','build','--platform','linux/amd64']
  if target: args+=['--target',target]
  run(args+['-t',tag,str(context)],'build-'+name+'.log')
  images[name]={'tag':tag,'id':output(['docker','image','inspect','--format','{{.Id}}',tag])}
 (bundle/'build-images.json').write_text(json.dumps(images,indent=2)+'\n')
 for name,prefix in [('app','image'),('job','codex-job'),('supervisor','codex-supervisor'),('code_truth','code-truth')]:
  for field,suffix in [('tag','tag'),('id','id')]: (bundle/(prefix+'-'+suffix)).write_text(images[name][field]+'\n')
 stage('exact_image_runtime_and_disposable_database_checks')
 run(['python3',str(bundle/'verify-images.py')],'container-checks.log')
 actual=json.loads((bundle/'artifact-hashes.json').read_text())
 assert {k.removeprefix('image-app/dist/'):v for k,v in actual.items() if k.startswith('image-app/dist/')}==json.loads((bundle/'expected-dist.json').read_text()),'VPS dist differs from the tested local image'
 stage('package_native_browser_host')
 package_tag='repodesk-browser-package:release-'+meta['source_commit']
 run(['docker','build','--platform','linux/amd64','--target','build','-f',str(source/'deploy/browser/smoke.Dockerfile'),'-t',package_tag,str(source)],'host-package-build.log')
 cid=output(['docker','create',package_tag,'bun','build','--target=bun','--packages=external','scripts/codex-conversation-proof.ts','--outfile','/tmp/browser-codex-proof.js'])
 try:
  run(['docker','cp',cid+':/package',str(bundle/'host-package')],'host-package-copy.log')
  run(['docker','cp',str(source/'scripts/codex-conversation-proof.ts'),cid+':/build/scripts/codex-conversation-proof.ts'],'proof-source-copy.log')
  run(['docker','start','-a',cid],'proof-bundle.log')
  assert output(['docker','inspect','--format','{{.State.ExitCode}}',cid])=='0'
  run(['docker','cp',cid+':/tmp/browser-codex-proof.js',str(bundle/'browser-codex-proof.js')],'proof-bundle-copy.log')
 finally:run(['docker','rm',cid],'host-package-cleanup.log')
 assert json.loads((bundle/'host-package/manifest.json').read_text())==json.loads((bundle/'expected-host-manifest.json').read_text()),'Host package differs from the locally tested package'
 stage('native_codex_dynamic_tool_proof')
 proof='repodesk-browser-native-proof-'+meta['release_id']
 run(['docker','create','--name',proof,'--network','none','-e','CODEX_BROWSER_PROOF=1','-e','CODEX_PROTOCOL_BINARY=/usr/local/bin/codex','--entrypoint','bun',images['job']['id'],'/opt/deepx/browser-proof.js'],'native-codex-create.log')
 try:
  run(['docker','cp',str(bundle/'browser-codex-proof.js'),proof+':/opt/deepx/browser-proof.js'],'native-codex-copy.log')
  run(['docker','start','-a',proof],'native-codex-proof.log')
  assert output(['docker','inspect','--format','{{.State.ExitCode}}',proof])=='0'
 finally: run(['docker','rm','-f',proof],'native-codex-cleanup.log')
 stage('install_host_prerequisites')
 env=os.environ.copy();env.update(DEBIAN_FRONTEND='noninteractive',NEEDRESTART_MODE='l')
 run(['apt-get','update'],'host-apt-update.log',env=env)
 run(['apt-get','-o','DPkg::Lock::Timeout=180','install','-y','--no-install-recommends','xvfb','xauth','dbus-daemon','dbus-x11','nftables','passwd','procps','ca-certificates','curl','fonts-liberation','fonts-noto-cjk','libatomic1','libstdc++6'],'host-prerequisites.log',env=env)
 browser=next((shutil.which(c) for c in ['google-chrome','chromium','chromium-browser'] if shutil.which(c)),None)
 if not browser:
  deb=bundle/'google-chrome.deb'
  run(['curl','--fail','--location','--proto','=https','--tlsv1.2','--connect-timeout','20','--max-time','300','-o',str(deb),'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb'],'chrome-download.log')
  run(['apt-get','-o','DPkg::Lock::Timeout=180','install','-y','--no-install-recommends',str(deb)],'chrome-install.log',env=env)
  browser=shutil.which('google-chrome')
 assert browser
 run([browser,'--version'],'chrome-version.log')
 # Keep the host's global Node/tool configuration unchanged. Reuse the exact tested image's Node binary.
 node_dir=Path('/opt/repodesk-browser/runtime/bin');node_dir.mkdir(parents=True,exist_ok=True,mode=0o755)
 cid=output(['docker','create',images['app']['id']])
 try:run(['docker','cp',cid+':/usr/local/bin/node',str(node_dir/'node')],'host-node-copy.log')
 finally:run(['docker','rm',cid],'host-node-copy-cleanup.log')
 os.chown(node_dir/'node',0,0);os.chmod(node_dir/'node',0o755)
 run([str(node_dir/'node'),'--version'],'host-node-version.log')
 dropin=Path('/etc/systemd/system/repodesk-browser.service.d');dropin.mkdir(parents=True,exist_ok=True,mode=0o755)
 runtime_path=str(node_dir)+':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
 (dropin/'runtime.conf').write_text('[Service]\nEnvironment="PATH='+runtime_path+'"\n');os.chmod(dropin/'runtime.conf',0o644)
 stage('install_native_browser_service')
 env.update(PATH=runtime_path,BROWSER_EXECUTABLE=browser)
 run(['bash',str(bundle/'host-package/install.sh'),str(bundle/'host-package'),str(root/'secrets')],'host-install.log',env=env)
 run(['systemctl','is-active','--quiet','repodesk-browser'],'host-active.log')
 stage('headed_browser_application_uid_probe')
 probe_cmd=['docker','run','--rm','--network','host','--group-add','1000','--volume','/run/repodesk-browser:/run/repodesk-browser:ro','--volume',str(root/'secrets/browser-token')+':/run/secrets/browser_token:ro','--volume',str(bundle/'host-probe.mjs')+':/app/host-probe.mjs:ro','--entrypoint','node',images['app']['id'],'/app/host-probe.mjs']
 # The script is public operational code, readable by the application's UID 1000.
 os.chmod(bundle/'host-probe.mjs',0o644)
 run(probe_cmd,'native-host-verification.json')
 native=json.loads((bundle/'native-host-verification.json').read_text());assert native['headed'] and native['cleaned'] and native['applicationUid']==1000
 native.update(chromeVersion=(bundle/'chrome-version.log').read_text().strip(),nodeVersion=(bundle/'host-node-version.log').read_text().strip(),hostManifest=hashlib.sha256((bundle/'host-package/manifest.json').read_bytes()).hexdigest())
 (bundle/'native-host-verification.json').write_text(json.dumps(native,indent=2)+'\n')
 stage('recheck_production_state_before_cutover')
 run(['python3',str(bundle/'capture-state.py'),str(bundle/'pre-cutover-state.json')],'pre-cutover.log')
 assert (root/'.current-release').read_text().strip()==meta['previous_release_id']
 assert json.loads((bundle/'baseline.json').read_text())['secret_hashes']==json.loads((bundle/'pre-cutover-state.json').read_text())['secret_hashes']
 stage('guarded_backup_migration_and_cutover')
 run(['bash',str(bundle/'deploy-vps.sh'),str(root),meta['release_id'],'repodesk','--local-images'],'cutover.log')
 stage('verify_live_images_assets_and_preserved_state')
 run(['python3',str(bundle/'verify-deployment.py'),str(bundle)],'production-verification.log')
 stage('deployment_verified')
except Exception as error:
 (bundle/'failure.json').write_text(json.dumps({'stage':(bundle/'stage').read_text().strip(),'error':type(error).__name__,'message':str(error)})+'\n')
 stage('deployment_failed')
 raise
