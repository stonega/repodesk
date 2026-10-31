import subprocess, json, os, secrets, shutil, hashlib, re, urllib.request
from pathlib import Path
bundle=Path(__file__).resolve().parent
source=bundle/'source'
meta=json.loads((bundle/'source-metadata.json').read_text())
images=json.loads((bundle/'build-images.json').read_text())
def run(args,name,**kwargs):
    with (bundle/name).open('wb') as log:
        subprocess.run(args,stdout=log,stderr=subprocess.STDOUT,check=True,**kwargs)
run(['docker','run','--rm','--network','none','--entrypoint','node',images['app']['id'],'dist/runtime-contract.js'],'runtime-contract.log')
print('Exact application image: Node runtime contract passed.',flush=True)
run(['docker','run','--rm','--network','none','--entrypoint','/opt/repodesk-asr/bin/python',images['app']['id'],'-c','import torch,torchaudio,qwen_asr; assert torch.__version__.startswith("2.6.0"); assert torchaudio.__version__.startswith("2.6.0"); assert not torch.cuda.is_available(); print("Pinned CPU transcription runtime imports passed")'],'transcription-runtime.log')
run(['docker','run','--rm','--network','none','--read-only','--tmpfs','/tmp:rw,mode=1777','--cap-drop','ALL','--security-opt','no-new-privileges:true',images['code_truth']['id'],'bun','scripts/smoke.ts'],'code-truth-smoke.log')
print('Transcription runtime and offline Code Truth smoke passed.',flush=True)

run(['docker','run','--rm','--network','none','--entrypoint','node',images['supervisor']['id'],'-e',"const fs=require('fs'),cp=require('child_process');fs.accessSync('/etc/ssl/certs/ca-certificates.crt');const r=cp.spawnSync('codex',['--version'],{stdio:'inherit'});if(r.status!==0)process.exit(1)"],'supervisor-runtime.log')
run(['docker','run','--rm','--network','none','--entrypoint','codex',images['job']['id'],'--version'],'job-cli.log')

smoke=bundle/'smoke'
(smoke/'secrets').mkdir(parents=True,exist_ok=True,mode=0o700)
key=smoke/'secrets/encryption-key'
key.write_text(secrets.token_hex(32)+'\n')
key.chmod(0o644)
envfile=smoke/'.env'
envfile.write_text('\n'.join(['POSTGRES_PASSWORD='+secrets.token_hex(24),'PUBLIC_ORIGIN=http://localhost:33149','APP_PORT=33149','TELEGRAM_TRANSPORT=polling','APP_IMAGE='+images['app']['id'],'CODE_TRUTH_IMAGE='+images['code_truth']['id'],'CODEX_SUPERVISOR_IMAGE='+images['supervisor']['id'],'CODEX_RUNNER_IMAGE='+images['job']['id'],'CODEX_RUNNER_TOKEN='+secrets.token_hex(32),'CODEX_RUNNER_NETWORK=repodesk_browser_smoke_tasks','']))
envfile.chmod(0o600)
(smoke/'local-selinux.yaml').write_text('services:\n  app:\n    security_opt: [label=disable]\n  worker:\n    security_opt: [label=disable]\n  migrate:\n    security_opt: [label=disable]\n')
compose=['docker','compose','--project-directory',str(smoke),'-p','repodesk-browser-smoke','--env-file',str(envfile),'-f',str(source/'compose.yaml'),'-f',str(source/'deploy/codex/docker-compose.yaml'),'-f',str(smoke/'local-selinux.yaml')]
run(compose+['config','--quiet'],'compose-config.log')
try:
    run(compose+['up','-d','--no-build','--pull','never','--wait','--wait-timeout','120','postgres'],'compose-postgres.log')
    run(compose+['exec','-T','postgres','sh','-c','until pg_isready -h 127.0.0.1 -U deepx -d deepx; do sleep 1; done'],'compose-postgres-tcp.log')
    run(compose+['up','-d','--no-build','--pull','never','--wait','--wait-timeout','180'],'compose-up.log')
    for service in ['app','worker']:
        run(compose+['exec','-T',service,'node','-e',"const fs=require('fs');fetch(process.env.CODE_TRUTH_URL+'/health/ready',{headers:{authorization:'Bearer '+fs.readFileSync(process.env.CODE_TRUTH_TOKEN_FILE,'utf8').trim()},signal:AbortSignal.timeout(10000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"],f'compose-{service}-code-truth.log')
    for path in ['/healthz','/readyz','/admin']:
        with urllib.request.urlopen('http://127.0.0.1:33149'+path,timeout=15) as response:
            assert response.status==200
    run(compose+['run','--rm','--no-deps','--pull','never','-T','migrate'],'migrate-rerun.log')
    dump=smoke/'backup.dump'
    with dump.open('wb') as out:
        subprocess.run(compose+['exec','-T','postgres','pg_dump','-U','deepx','-d','deepx','--format=custom'],stdout=out,check=True)
    dump.chmod(0o600)
    with dump.open('rb') as data:
        run(compose+['exec','-T','postgres','pg_restore','--list'],'backup-list.log',stdin=data)
    run(compose+['exec','-T','postgres','createdb','-U','deepx','startup_restore'],'restore-create.log')
    with dump.open('rb') as data:
        run(compose+['exec','-T','postgres','pg_restore','-U','deepx','-d','startup_restore','--no-owner','--exit-on-error'],'restore.log',stdin=data)
    run(compose+['exec','-T','postgres','psql','-v','ON_ERROR_STOP=1','-U','deepx','-d','startup_restore','-c','SELECT count(*) AS migrations FROM schema_migrations; SELECT count(*) AS deployments FROM deployment; SELECT count(*) AS workspaces FROM workspaces;'],'restore-counts.log')
    print('Exact-image Compose readiness, migration rerun and backup/restore passed.',flush=True)
except Exception:
    run(compose+['logs','--no-color','--tail','100'],'compose-failure.log')
    raise
finally:
    run(compose+['down','--volumes'],'compose-cleanup.log')
    envfile.unlink(missing_ok=True)
    key.unlink(missing_ok=True)
artifacts={'server':'dist/server.js','worker':'dist/worker.js','frontend':'dist/web/assets/app.js','stylesheet':'dist/web/assets/app.css','supervisor':'dist/runner-server.js','job':'/opt/deepx/job.js'}
# Hash the complete dist trees without copying any runtime configuration.
for name in ['app','supervisor','job']:
    cid=subprocess.check_output(['docker','create',images[name]['id']],text=True).strip()
    dest=bundle/f'image-{name}'
    dest.mkdir(exist_ok=True)
    try:
        location='/opt/deepx/job.js' if name=='job' else '/app/dist'
        subprocess.run(['docker','cp',cid+':'+location,str(dest)],check=True,stdout=subprocess.DEVNULL)
    finally:
        subprocess.run(['docker','rm',cid],check=True,stdout=subprocess.DEVNULL)
hashes={str(p.relative_to(bundle)):hashlib.sha256(p.read_bytes()).hexdigest() for name in ['app','supervisor','job'] for p in (bundle/f'image-{name}').rglob('*') if p.is_file()}
(bundle/'artifact-hashes.json').write_text(json.dumps(hashes,indent=2)+'\n')
(bundle/'container-verification.json').write_text(json.dumps({'source_tree':meta['source_tree'],'images':images,'node_runtime':True,'transcription_runtime':True,'code_truth_offline':True,'compose_config':True,'compose_readiness':True,'migration_rerun':True,'backup_restore':True},indent=2)+'\n')
print('All container checks passed.',flush=True)
