import hashlib,json,os,subprocess,sys
from pathlib import Path
os.umask(0o077)
bundle=Path(sys.argv[1]);root=Path('/opt/repodesk');meta=json.loads((bundle/'source-metadata.json').read_text())
def run(args,log,**kw):
 with (bundle/log).open('wb') as output:subprocess.run(args,stdout=output,stderr=subprocess.STDOUT,check=True,**kw)
def stage(value):(bundle/'stage').write_text(value+'\n')
try:
 stage('resume_verify_immutable_release')
 assert (root/'.current-release').read_text().strip()==meta['previous_release_id']
 assert not (root/'backups'/('pre-release-'+meta['release_id']+'.dump')).exists()
 for name,digest in json.loads((bundle/'payload-checksums.json').read_text()).items():assert hashlib.sha256((bundle/name).read_bytes()).hexdigest()==digest,name
 images=json.loads((bundle/'build-images.json').read_text())
 for item in images.values():assert subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',item['tag']],text=True).strip()==item['id']
 checks=json.loads((bundle/'container-verification.json').read_text());assert checks['node_runtime'] and checks['code_truth_offline'] and checks['backup_restore']
 stage('resume_host_prerequisite_repair')
 for module in ['nf_tables','nft_reject_inet']:
  run(['modprobe',module],'resume-module-'+module+'.log')
 config=Path('/etc/modules-load.d/repodesk-browser.conf')
 config.write_text('nf_tables\nnft_reject_inet\n');os.chmod(config,0o644)
 run(['nft','--check','-f','-'],'resume-firewall-check.log',input=b'add table inet rdb_browser_readiness\nadd chain inet rdb_browser_readiness output { type filter hook output priority -10; policy accept; }\nadd chain inet rdb_browser_readiness unused\nadd rule inet rdb_browser_readiness unused meta skuid 997 ip daddr 127.0.0.1 tcp dport 1 accept\nadd rule inet rdb_browser_readiness unused reject\ndelete table inet rdb_browser_readiness\n')
 stage('resume_build_verified_native_host_fix')
 fix_commit=(bundle/'resume-commit').read_text().strip()
 assert len(fix_commit)==40 and all(c in '0123456789abcdef' for c in fix_commit)
 archive=bundle/('native-source-'+fix_commit+'.tar.gz')
 digest=(bundle/('native-source-'+fix_commit+'.sha256')).read_text().strip()
 assert hashlib.sha256(archive.read_bytes()).hexdigest()==digest
 fix=bundle/('native-host-fix-'+fix_commit);fix.mkdir(mode=0o700)
 source=fix/'source';source.mkdir(mode=0o700)
 run(['tar','-xzf',str(archive),'-C',str(source)],'resume-native-source-extract.log')
 package_image='repodesk-browser-package:native-fix-'+fix_commit
 run(['docker','build','--platform','linux/amd64','--target','build','-f',str(source/'deploy/browser/smoke.Dockerfile'),'-t',package_image,str(source)],'resume-native-package-build.log')
 cid=subprocess.check_output(['docker','create',package_image],text=True).strip()
 try:run(['docker','cp',cid+':/package',str(fix/'package')],'resume-native-package-copy.log')
 finally:run(['docker','rm',cid],'resume-native-package-cleanup.log')
 assert json.loads((fix/'package/manifest.json').read_text())==json.loads((bundle/('native-manifest-'+fix_commit+'.json')).read_text()),'Native fix differs from the locally verified package'
 compatibility_image='repodesk-browser-nft:native-fix-'+fix_commit
 run(['docker','build','--platform','linux/amd64','--target','nft-compatibility','-f',str(source/'deploy/browser/smoke.Dockerfile'),'-t',compatibility_image,str(source)],'resume-nft-build.log')
 run(['docker','run','--rm','--network','none','--cap-add','NET_ADMIN',compatibility_image],'resume-nft-verification.json')
 assert json.loads((bundle/'resume-nft-verification.json').read_text())['nodeUbuntuFirewall']
 stage('resume_install_verified_native_host_fix')
 env=os.environ.copy();env.update(PATH='/opt/repodesk-browser/runtime/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',BROWSER_EXECUTABLE='/usr/bin/google-chrome')
 run(['bash',str(fix/'package/install.sh'),str(fix/'package'),str(root/'secrets')],'resume-native-install.log',env=env)

 stage('resume_headed_application_uid_probe')
 old=bundle/'native-host-verification.json'
 if old.exists():old.rename(bundle/'native-host-verification-initial-failure.log')
 run(['docker','run','--rm','--network','host','--group-add','1000','--volume','/run/repodesk-browser:/run/repodesk-browser:ro','--volume',str(root/'secrets/browser-token')+':/run/secrets/browser_token:ro','--volume',str(bundle/'host-probe.mjs')+':/app/host-probe.mjs:ro','--entrypoint','node',images['app']['id'],'/app/host-probe.mjs'],'native-host-verification.json')
 native=json.loads((bundle/'native-host-verification.json').read_text());assert native['headed'] and native['cleaned'] and native['applicationUid']==1000
 native.update(chromeVersion=(bundle/'chrome-version.log').read_text().strip(),nodeVersion=(bundle/'host-node-version.log').read_text().strip(),hostManifest=hashlib.sha256((fix/'package/manifest.json').read_bytes()).hexdigest(),sourceCommit=fix_commit,sourceArchiveSha256=digest,nodeUbuntuFirewall=True)
 (bundle/'native-host-verification.json').write_text(json.dumps(native,indent=2)+'\n')
 stage('resume_recheck_production_configuration')
 run(['python3',str(bundle/'capture-state.py'),str(bundle/'pre-cutover-state.json')],'pre-cutover.log')
 assert json.loads((bundle/'baseline.json').read_text())['secret_hashes']==json.loads((bundle/'pre-cutover-state.json').read_text())['secret_hashes']
 stage('guarded_backup_migration_and_cutover')
 run(['bash',str(bundle/'deploy-vps.sh'),str(root),meta['release_id'],'repodesk','--local-images'],'cutover.log')
 stage('verify_live_images_assets_and_preserved_state')
 run(['python3',str(bundle/'verify-deployment.py'),str(bundle)],'production-verification.log')
 receipt=json.loads((bundle/'deployment-receipt.json').read_text());receipt['operational_resume_commit']=(bundle/'resume-commit').read_text().strip();(bundle/'deployment-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
 stage('deployment_verified')
except Exception as error:
 (bundle/'failure.json').write_text(json.dumps({'stage':(bundle/'stage').read_text().strip(),'error':type(error).__name__,'message':str(error)})+'\n');stage('deployment_failed');raise
