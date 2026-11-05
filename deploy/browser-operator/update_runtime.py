"""Small runtime boundaries shared by initial and resumed Browser cutovers."""
import json
import subprocess
import hashlib
import shutil


def command_json(args, log, input=None):
    # Compose progress belongs on stderr, never in a machine-readable receipt.
    with log.open('wb') as errors:
        result = subprocess.run(args, input=input, stdout=subprocess.PIPE,
                                stderr=errors, check=True)
    return json.loads(result.stdout)


def start_unchanged_writers(baseline, names, engine=None):
    engine = ['docker'] if engine is None else list(engine)
    for name in names:
        name = {'app': 'repodesk-app-1', 'worker': 'repodesk-worker-1'}.get(name, name)
        assert name in ['repodesk-app-1', 'repodesk-worker-1']
        expected = baseline['containers'][name]
        current = json.loads(subprocess.check_output(engine + ['inspect', name]))[0]
        assert current['Id'] == expected['id'] and current['Image'] == expected['image']
        if current['State']['Status'] != 'running':
            subprocess.run(engine + ['start', expected['id']],
                           stdout=subprocess.DEVNULL, check=True)


def preserve_host_backup(installed, backup):
    existing = backup.exists()
    directory = backup if existing else installed
    manifest = json.loads((directory / 'manifest.json').read_text())
    if not existing:
        backup.mkdir(mode=0o700)
    for name, digest in manifest.items():
        relative = type(installed)(name)
        assert not relative.is_absolute() and '..' not in relative.parts
        original = directory / relative
        assert hashlib.sha256(original.read_bytes()).hexdigest() == digest
        if not existing:
            destination = backup / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, destination)
    if not existing:
        shutil.copyfile(installed / 'manifest.json', backup / 'manifest.json')
