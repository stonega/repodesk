"""Small runtime boundaries shared by initial and resumed Browser cutovers."""
import json
import subprocess


def command_json(args, log, input=None):
    # Compose progress belongs on stderr, never in a machine-readable receipt.
    with log.open('wb') as errors:
        result = subprocess.run(args, input=input, stdout=subprocess.PIPE,
                                stderr=errors, check=True)
    return json.loads(result.stdout)


def start_unchanged_writers(baseline, names, engine=None):
    engine = ['docker'] if engine is None else list(engine)
    for name in names:
        assert name in ['repodesk-app-1', 'repodesk-worker-1']
        expected = baseline['containers'][name]
        current = json.loads(subprocess.check_output(engine + ['inspect', name]))[0]
        assert current['Id'] == expected['id'] and current['Image'] == expected['image']
        if current['State']['Status'] != 'running':
            subprocess.run(engine + ['start', expected['id']],
                           stdout=subprocess.DEVNULL, check=True)
