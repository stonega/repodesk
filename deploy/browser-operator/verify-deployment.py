import sys, json, subprocess, hashlib, urllib.request, re, datetime, os
from pathlib import Path
root=Path('/opt/repodesk')
release=Path(sys.argv[1])
meta=json.loads((release/'source-metadata.json').read_text())
assert (root/'.current-release').read_text().strip()==meta['release_id']
subprocess.run(['python3',str(release/'capture-state.py'),str(release/'after-state.json')],stdout=subprocess.DEVNULL,check=True)
before=json.loads((release/'baseline.json').read_text())
after=json.loads((release/'after-state.json').read_text())
assert before['secret_hashes']==after['secret_hashes'],'Configuration or credentials changed'
for name,value in before['containers'].items():
    new=after['containers'][name]
    extra={'/run/repodesk-browser','/run/secrets/browser_token'} if name in ['repodesk-app-1','repodesk-worker-1'] else set()
    retained=[m for m in new['mounts'] if m['Destination'] not in extra]
    assert sorted(value['mounts'],key=lambda m:m['Destination'])==sorted(retained,key=lambda m:m['Destination']),f'Persistent mounts changed for {name}'
    if name=='repodesk-postgres-1' or name.startswith('repodesk-actions-runner-'):
        assert value['id']==new['id'],f'Unrelated container was replaced: {name}'
for name in ['repodesk-app-1','repodesk-worker-1','repodesk-codex-runner-1','repodesk-code-truth-1']:
    assert after['containers'][name]['status']=='running' and after['containers'][name]['health']=='healthy',f'Service unhealthy: {name}'
actual={}
for key,name in [('app','repodesk-app-1'),('supervisor','repodesk-codex-runner-1'),('code_truth','repodesk-code-truth-1')]:
    actual[key]=after['containers'][name]['image']
    tag=(release/{'app':'image-tag','supervisor':'codex-supervisor-tag','code_truth':'code-truth-tag'}[key]).read_text().strip()
    expected=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',tag],text=True).strip()
    assert actual[key]==expected,f'Image mismatch for {key}'
assert after['containers']['repodesk-worker-1']['image']==actual['app']
hashes=json.loads((release/'artifact-hashes.json').read_text())
verified=0
for key,expected in hashes.items():
    part,path=key.split('/',1)
    if part=='image-app':
        container='repodesk-app-1'; absolute='/app/'+path
    elif part=='image-supervisor':
        container='repodesk-codex-runner-1'; absolute='/app/'+path
    elif part=='image-job':
        tag=(release/'codex-job-tag').read_text().strip()
        script="const fs=require('fs'),crypto=require('crypto');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))"
        result=subprocess.check_output(['docker','run','--rm','--network','none','--entrypoint','node',tag,'-e',script,'/opt/deepx/'+path],text=True).strip()
        assert result==expected,'Task image artifact mismatch'
        image_id=subprocess.check_output(['docker','image','inspect','--format','{{.Id}}',tag],text=True).strip()
        configured=subprocess.check_output(['docker','exec','repodesk-codex-runner-1','node','-e','process.stdout.write(process.env.CODEX_RUNNER_IMAGE)'],text=True).strip()
        assert configured==image_id,'Runner task image mismatch'
        verified+=1
        continue
    else:
        raise ValueError(key)
    script="const fs=require('fs'),crypto=require('crypto');process.stdout.write(crypto.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))"
    result=subprocess.check_output(['docker','exec',container,'node','-e',script,absolute],text=True).strip()
    assert result==expected,f'Artifact mismatch: {key}'
    verified+=1
archive_hash=hashlib.sha256((release/'source.tar.gz').read_bytes()).hexdigest()
assert archive_hash==meta['source_sha256']
http={}
html_verification={}
def request_url(url):
    return urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'RepoDesk-Deployment-Verification/1.0'}),timeout=20)
for origin in ['http://127.0.0.1:3000','https://dev.stonegate.me']:
    paths={}
    for path in ['/healthz','/readyz','/admin','/mini']:
        with request_url(origin+path) as response:
            assert response.status==200
            body=response.read()
            paths[path]=response.status
        if path=='/admin':
            expected_html=hashes['image-app/dist/web/index.html']
            raw_hash=hashlib.sha256(body).hexdigest()
            normalized=body.decode()
            beacon_removed=False
            if raw_hash!=expected_html and origin=='https://dev.stonegate.me':
                # Only the observed Cloudflare analytics insertion is allowed.
                pattern=r"<script type=\"module\" src=\"https://static\.cloudflareinsights\.com/beacon\.min\.js/v[a-f0-9]+\" integrity=\"sha512-[A-Za-z0-9+/=]+\" data-cf-beacon='[^'<>]*' crossorigin=\"anonymous\"></script>\n?"
                normalized,count=re.subn(pattern,'',normalized,count=1)
                beacon_removed=count==1
            normalized_hash=hashlib.sha256(normalized.encode()).hexdigest()
            assert normalized_hash==expected_html,'Unexpected admin HTML difference'
            html_verification[origin]={'origin_sha256':expected_html,'served_sha256':raw_hash,'normalized_sha256':normalized_hash,'cloudflare_analytics_insertion':beacon_removed}
            html=body.decode()
            assets=set(re.findall(r"(?:src|href)=[\"'](/assets/[^\"']+\.(?:js|css)(?:\?[^\"']*)?)[\"']",html))
            assert assets,'No frontend assets found'
            for asset in assets:
                key='image-app/dist/web'+asset.split('?',1)[0]
                with request_url(origin+asset) as response:
                    payload=response.read()
                    assert response.status==200
                assert hashlib.sha256(payload).hexdigest()==hashes[key],f'Served asset mismatch: {asset}'
                paths[asset]=200
    # Verify every packaged frontend asset, including Mini App assets and the icon.
    for key,expected in hashes.items():
        if not key.startswith('image-app/dist/web/assets/'): continue
        asset=key.removeprefix('image-app/dist/web')
        with request_url(origin+asset) as response:
            assert response.status==200
            payload=response.read()
        assert hashlib.sha256(payload).hexdigest()==expected,'Served asset mismatch: '+asset
        paths[asset]=200
    http[origin]=paths
backup=root/'backups'/f"pre-release-{meta['release_id']}.dump"
assert backup.stat().st_size>0
with backup.open('rb') as data:
    subprocess.run(['docker','exec','-i','repodesk-postgres-1','pg_restore','--list'],stdin=data,stdout=subprocess.DEVNULL,check=True)
receipt={'release_id':meta['release_id'],'previous_release_id':before['release_id'],'source_commit':meta['source_commit'],'fix_commit':meta['source_commit'],'source_base_commit':meta['base_commit'],'source_tree':meta['source_tree'],'package_version':meta['package_version'],'verified_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'services':{name:{'image':after['containers'][name]['image'],'health':after['containers'][name]['health']} for name in ['repodesk-app-1','repodesk-worker-1','repodesk-codex-runner-1','repodesk-code-truth-1']},'verified_artifacts':verified,'source_archive_verified':True,'public_and_loopback_http':http,'html_verification':html_verification,'configuration_and_credentials_preserved':True,'persistent_volumes_preserved':True,'postgres_and_actions_runners_preserved':True,'browser_host':json.loads((release/'native-host-verification.json').read_text()),'backup':{'path':str(backup),'bytes':backup.stat().st_size,'archive_verified':True}}
output=release/'deployment-receipt.json'
output.write_text(json.dumps(receipt,indent=2)+'\n')
os.chmod(output,0o600)
print(json.dumps(receipt,indent=2))
