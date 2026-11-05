"""Update an installed Browser deployment from an immutable, verified bundle."""
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path
from update_runtime import command_json, start_unchanged_writers, preserve_host_backup

os.umask(0o077)
bundle = Path(sys.argv[1]).resolve()
root = Path('/opt/repodesk')
source = bundle / 'source'
meta = json.loads((bundle / 'source-metadata.json').read_text())
previous = root / 'releases' / meta['previous_release_id']
frozen = False
cutover = False
writers = []


def stage(name):
    (bundle / 'stage').write_text(name + '\n')
    print(name, flush=True)


def output(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def run(args, log, **kwargs):
    with (bundle / log).open('wb') as stream:
        subprocess.run(args, stdout=stream, stderr=subprocess.STDOUT,
                       check=True, **kwargs)


def compose(directory):
    return ['docker', 'compose', '--project-directory', str(root), '-p', 'repodesk',
            '--env-file', str(root / '.env'), '--env-file', str(directory / 'release.env'),
            '--env-file', str(directory / 'codex.env'), '-f', str(directory / 'compose.yaml'),
            '-f', str(directory / 'codex-compose.yaml')]


def wait_socket():
    for _ in range(120):
        try:
            value = Path('/run/repodesk-browser/control.sock').stat()
            if stat.S_ISSOCK(value.st_mode) and stat.S_IMODE(value.st_mode) == 0o660 and value.st_gid == 1000:
                return
        except FileNotFoundError:
            pass
        time.sleep(.25)
    raise RuntimeError('browser_host_socket_not_ready')


def browser_checkpoint():
    result = json.loads(subprocess.check_output(
        ['docker', 'exec', '-i', 'repodesk-app-1', 'node', '--input-type=module'],
        input=(bundle / 'browser-checkpoint.mjs').read_bytes()))
    return result


try:
    if len(sys.argv) > 2 and sys.argv[2] == '--resume':
        assert (root / '.current-release').read_text().strip() == meta['previous_release_id']
        assert (bundle / 'stage').read_text().strip() in ['wait_for_browser_and_coding_checkpoints', 'deployment_failed']
        assert not (bundle / 'cutover.log').exists()
        assert hashlib.sha256((bundle / 'source.tar.gz').read_bytes()).hexdigest() == meta['source_sha256']
        images = json.loads((bundle / 'build-images.json').read_text())
        verified = json.loads((bundle / 'container-verification.json').read_text())
        assert verified['images'] == images and all(verified.get(key) for key in ['node_runtime','transcription_runtime','code_truth_offline','compose_config','compose_readiness','migration_rerun','backup_restore'])
        for item in images.values():
            assert output(['docker','image','inspect','--format','{{.Id}}',item['tag']]) == item['id']
        assert json.loads((bundle / 'host-package/manifest.json').read_text()) == json.loads((bundle / 'expected-host-manifest.json').read_text())
        run(['python3', str(bundle / 'capture-state.py'), str(bundle / 'resume-baseline.json')], 'resume-baseline.log')
        old = json.loads((bundle / 'baseline.json').read_text())
        current = json.loads((bundle / 'resume-baseline.json').read_text())
        assert old['secret_hashes'] == current['secret_hashes']
        stage('resume_verified_pre_cutover_images')
    else:
        stage('verify_source_and_capture_baseline')
        assert output(['id', '-u']) == '0'
        assert (root / '.current-release').read_text().strip() == meta['previous_release_id']
        for name, digest in json.loads((bundle / 'payload-checksums.json').read_text()).items():
            assert hashlib.sha256((bundle / name).read_bytes()).hexdigest() == digest, name
        assert hashlib.sha256((bundle / 'source.tar.gz').read_bytes()).hexdigest() == meta['source_sha256']
        run(['python3', str(bundle / 'capture-state.py'), str(bundle / 'baseline.json')], 'baseline.log')
        source.mkdir(mode=0o700)
        run(['tar', '-xzf', str(bundle / 'source.tar.gz'), '-C', str(source)], 'source-extract.log')
        images = {}
        for name, repository, target in [('app', 'repodesk', 'app'),
                                          ('job', 'repodesk-codex-job', 'codex-job'),
                                          ('supervisor', 'repodesk-codex-supervisor', 'codex-supervisor')]:
            stage('build_' + name)
            assert shutil.disk_usage(root).free > 6 * 1024**3, 'disk_headroom'
            tag = repository + ':release-' + meta['source_commit']
            run(['docker', 'build', '--platform', 'linux/amd64', '--target', target,
                 '-t', tag, str(source)], 'build-' + name + '.log')
            images[name] = {'tag': tag, 'id': output(['docker', 'image', 'inspect', '--format', '{{.Id}}', tag])}
        # Code Truth's source subtree is unchanged from the existing deployment.
        assert meta['code_truth_tree'] == meta['previous_code_truth_tree']
        old_truth = json.loads((previous / 'build-images.json').read_text())['code_truth']
        truth_tag = 'repodesk-code-truth:release-' + meta['source_commit']
        run(['docker', 'tag', old_truth['id'], truth_tag], 'code-truth-retag.log')
        images['code_truth'] = {'tag': truth_tag, 'id': old_truth['id']}
        (bundle / 'build-images.json').write_text(json.dumps(images, indent=2) + '\n')
        for name, prefix in [('app', 'image'), ('job', 'codex-job'), ('supervisor', 'codex-supervisor'), ('code_truth', 'code-truth')]:
            for field in ['tag', 'id']:
                (bundle / f'{prefix}-{field}').write_text(images[name][field] + '\n')
        stage('exact_image_runtime_and_disposable_database_checks')
        run(['python3', str(bundle / 'verify-images.py')], 'container-checks.log')
        actual = json.loads((bundle / 'artifact-hashes.json').read_text())
        assert {k.removeprefix('image-app/dist/'): v for k, v in actual.items()
                if k.startswith('image-app/dist/')} == json.loads((bundle / 'expected-dist.json').read_text())
        stage('package_native_browser_host')
        package_tag = 'repodesk-browser-package:release-' + meta['source_commit']
        run(['docker', 'build', '--platform', 'linux/amd64', '--target', 'build', '-f',
             str(source / 'deploy/browser/smoke.Dockerfile'), '-t', package_tag, str(source)], 'host-package-build.log')
        cid = output(['docker', 'create', package_tag, 'true'])
        try:
            run(['docker', 'cp', cid + ':/package', str(bundle / 'host-package')], 'host-package-copy.log')
        finally:
            run(['docker', 'rm', cid], 'host-package-cleanup.log')
        assert json.loads((bundle / 'host-package/manifest.json').read_text()) == json.loads((bundle / 'expected-host-manifest.json').read_text())
        stage('native_codex_dynamic_tool_proof')
        proof = 'repodesk-browser-native-proof-' + meta['release_id']
        run(['docker', 'create', '--name', proof, '--network', 'none', '-e', 'CODEX_BROWSER_PROOF=1',
             '-e', 'CODEX_PROTOCOL_BINARY=/usr/local/bin/codex', '--entrypoint', 'bun',
             images['job']['id'], '/opt/deepx/browser-proof.js'], 'native-codex-create.log')
        try:
            run(['docker', 'cp', str(bundle / 'browser-codex-proof.mjs'), proof + ':/opt/deepx/browser-proof.js'], 'native-codex-copy.log')
            run(['docker', 'start', '-a', proof], 'native-codex-proof.log')
            assert output(['docker', 'inspect', '--format', '{{.State.ExitCode}}', proof]) == '0'
        finally:
            run(['docker', 'rm', proof], 'native-codex-cleanup.log')
    stage('verify_existing_configuration_and_secret_bindings')
    shutil.copyfile(previous / 'compose.yaml', bundle / 'compose.yaml')
    (bundle / 'release.env').write_text('APP_IMAGE=' + images['app']['id'] + '\nCODE_TRUTH_IMAGE=' + images['code_truth']['id'] + '\n')
    run(['docker', 'run', '--rm', '--network', 'none', '--user', '0:0',
         '--volume', str(root) + ':/deployment', '--volume', str(bundle) + ':/release',
         '--env', 'CODEX_SUPERVISOR_IMAGE=' + images['supervisor']['id'],
         '--env', 'CODEX_RUNNER_IMAGE=' + images['job']['id'], '--entrypoint', 'node',
         images['app']['id'], '/release/codex-release-config.mjs', '/deployment', '/release', 'repodesk'], 'codex-config-preflight.log')
    run(compose(bundle) + ['config', '--quiet'], 'production-compose-validation.log')
    for service in ['migrate', 'app', 'worker']:
        run(compose(bundle) + ['run', '--rm', '--no-deps', '--pull', 'never', '-T', '--entrypoint', 'node',
                              service, '-e', "const fs=require('fs');fs.accessSync(process.env.ENCRYPTION_KEY_FILE,fs.constants.R_OK);if(process.env.BROWSER_HOST_TOKEN_FILE)fs.accessSync(process.env.BROWSER_HOST_TOKEN_FILE,fs.constants.R_OK)"],
            'secret-preflight-' + service + '.log')
    stage('wait_for_browser_and_coding_checkpoints')
    deadline = time.monotonic() + 1800
    while True:
        counts = browser_checkpoint()
        if sum(counts.values()) == 0:
            break
        assert time.monotonic() < deadline, 'browser_checkpoint_timeout'
        print(json.dumps({'waiting_for_browser': counts}), flush=True)
        time.sleep(5)
    run(compose(previous) + ['exec', '-T', 'codex-runner', 'node', '--input-type=module', '-', '1800'],
        'coding-checkpoint-before-stop.log', input=(bundle / 'codex-wait-checkpoint.mjs').read_bytes())
    writers = output(compose(previous) + ['ps', '--status', 'running', '--services', 'app', 'worker']).split()
    frozen = True
    run(compose(previous) + ['stop', 'app', 'worker'], 'freeze-writers.log')
    run(compose(previous) + ['exec', '-T', 'codex-runner', 'node', '--input-type=module', '-', '1800'],
        'coding-checkpoint-after-stop.log', input=(bundle / 'codex-wait-checkpoint.mjs').read_bytes())
    # Prevent concurrent ingress from creating a fresh browser wait during the update.
    checkpoint = command_json(compose(previous) + ['run', '--rm', '--no-deps', '--pull', 'never', '-T', '--entrypoint', 'node',
                                                   'app', '--input-type=module'],
                              bundle / 'browser-checkpoint-after-stop.stderr', input=(bundle / 'browser-checkpoint.mjs').read_bytes())
    (bundle / 'browser-checkpoint-after-stop.json').write_text(json.dumps(checkpoint) + '\n')
    assert sum(checkpoint.values()) == 0, 'browser_checkpoint_changed'
    stage('install_native_browser_update')
    host_backup = bundle / 'previous-host-package'
    preserve_host_backup(Path('/opt/repodesk-browser'), host_backup)
    # Existing Node, Chrome, settings, host key, profiles and socket directory remain.
    runtime = '/opt/repodesk-browser/runtime/bin'
    env = os.environ.copy()
    env.update(PATH=runtime + ':' + env['PATH'], BROWSER_EXECUTABLE='/usr/bin/google-chrome')
    assert Path(runtime + '/node').is_file()
    run([runtime + '/node', '--version'], 'host-node-version.log')
    run(['/usr/bin/google-chrome', '--version'], 'chrome-version.log')
    socket_inode = Path('/run/repodesk-browser').stat().st_ino
    run(['bash', str(bundle / 'host-package/install.sh'), str(bundle / 'host-package'), str(root / 'secrets')],
        'host-install.log', env=env)
    wait_socket()
    assert Path('/run/repodesk-browser').stat().st_ino == socket_inode
    stage('headed_browser_application_uid_probe')
    os.chmod(bundle / 'host-probe.mjs', 0o644)
    native = command_json(['docker', 'run', '--rm', '--network', 'host', '--group-add', '1000',
         '--env', 'BROWSER_PROBE_ROUTINE=true',
         '--volume', '/run/repodesk-browser:/run/repodesk-browser:ro',
         '--volume', str(root / 'secrets/browser-token') + ':/run/secrets/browser_token:ro',
         '--volume', str(bundle / 'host-probe.mjs') + ':/app/host-probe.mjs:ro',
         '--entrypoint', 'node', images['app']['id'], '/app/host-probe.mjs'], bundle / 'native-host-verification.stderr')
    assert native['headed'] and native['cleaned'] and native['applicationUid'] == 1000
    assert native['nativeRoutineActions'] and native['externalSubmissionsGated']
    assert native['partitionedCookieCheckpoint']
    assert native['httpsRedirectConsent']
    assert native['verifiedPrivateDownload']
    native.update(socketDirectoryPreservedOnRestart=True,
                  chromeVersion=(bundle / 'chrome-version.log').read_text().strip(),
                  nodeVersion=(bundle / 'host-node-version.log').read_text().strip(),
                  hostManifest=hashlib.sha256((bundle / 'host-package/manifest.json').read_bytes()).hexdigest())
    (bundle / 'native-host-verification.json').write_text(json.dumps(native, indent=2) + '\n')
    assert (root / '.current-release').read_text().strip() == meta['previous_release_id']
    # Copy the already-correct, unexpanded composition so all inherited secret mounts survive.
    shutil.copyfile(previous / 'compose.yaml', bundle / 'compose.yaml')
    stage('guarded_backup_migration_and_cutover')
    cutover = True
    run(['bash', str(bundle / 'deploy-vps.sh'), str(root), meta['release_id'], 'repodesk', '--local-images'], 'cutover.log')
    stage('verify_live_images_assets_and_preserved_state')
    run(['python3', str(bundle / 'verify-deployment.py'), str(bundle)], 'production-verification.log')
    for name in ['repodesk-app-1', 'repodesk-worker-1']:
        run(['docker', 'exec', '-i', name, 'node', '--input-type=module'], name + '-browser-proof.json',
            input=(bundle / 'host-probe.mjs').read_bytes())
        result = json.loads((bundle / (name + '-browser-proof.json')).read_text())
        assert result['headed'] and result['cleaned']
    receipt = json.loads((bundle / 'deployment-receipt.json').read_text())
    receipt['feature_commit'] = meta['feature_commit']
    receipt['browser_host']['existingApiAndWorkerMountsVerified'] = True
    receipt['previous_features_preserved'] = True
    (bundle / 'deployment-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    stage('deployment_verified')
except Exception as error:
    # Before replacement, resuming the unchanged writers is safe. Never restore a DB
    # or replay writes automatically after a cutover failure.
    failure = {
        'stage': (bundle / 'stage').read_text().strip(), 'error': type(error).__name__,
        'code': 'browser_update_failed', 'cutover_started': cutover,
    }
    (bundle / 'failure.json').write_text(json.dumps(failure) + '\n')
    if frozen and not cutover and writers:
        try:
            start_unchanged_writers(json.loads((bundle / 'baseline.json').read_text()), writers)
            failure['previous_writers_restarted'] = True
        except Exception:
            failure['previous_writers_restarted'] = False
        (bundle / 'failure.json').write_text(json.dumps(failure) + '\n')
    stage('deployment_failed')
    raise
