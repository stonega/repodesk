import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(
  new URL("../../deploy/browser-operator/update_runtime.py", import.meta.url),
);
const load = `import importlib.util,json,sys,tempfile\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('update_runtime',sys.argv[1]);runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)\n`;

test("Browser update packaging rejects source that omits the deployed production commit", () => {
  const root = mkdtempSync(join(tmpdir(), "repodesk-release-ancestry-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const prepare = fileURLToPath(
    new URL(
      "../../deploy/browser-operator/prepare-update-payload.mjs",
      import.meta.url,
    ),
  );
  try {
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    for (const dir of [
      "services/code-truth",
      "migrations",
      "deploy/browser-operator",
      "payload",
    ])
      mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, "package.json"), '{"version":"0.1.46"}');
    writeFileSync(join(root, "services/code-truth/fixture"), "service");
    writeFileSync(join(root, "migrations/fixture"), "schema");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(root, "production-fix"), "retained");
    git("add", ".");
    git("commit", "-qm", "deployed fix");
    const production = git("rev-parse", "HEAD");
    const baseline = {
      previous_source_commit: production,
      previous_code_truth_tree: git("rev-parse", "HEAD:services/code-truth"),
      previous_migration_tree: git("rev-parse", "HEAD:migrations"),
    };
    git("checkout", "-q", "--detach", base);
    writeFileSync(
      join(root, "deploy/browser-operator/update-baseline.json"),
      JSON.stringify(baseline),
    );
    writeFileSync(join(root, "payload/source.tar.gz"), "fixture");
    const run = (commit: string) =>
      execFileSync(process.execPath, [prepare, join(root, "payload")], {
        cwd: root,
        env: { ...process.env, RELEASE_ID: "123-1", GITHUB_SHA: commit },
        stdio: "pipe",
      });
    expect(() => run(base)).toThrow(
      "update_source_does_not_preserve_production",
    );
    git("checkout", "-q", "--detach", production);
    expect(JSON.parse(run(production).toString()).source_commit).toBe(
      production,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Browser release checkpoint parses application JSON separately from Compose progress", () => {
  const script = `${load}
with tempfile.TemporaryDirectory() as root:
 log=Path(root)/'progress.log'
 code="import json,sys;print('Container checkpoint Starting',file=sys.stderr);print(json.dumps({'leases':0,'inputs':0,'requests':0}))"
 result=runtime.command_json([sys.executable,'-c',code],log)
 assert result=={'leases':0,'inputs':0,'requests':0}
 assert 'Starting' in log.read_text()
 print(json.dumps(result))
`;
  expect(
    JSON.parse(
      execFileSync("python3", ["-c", script, modulePath], { encoding: "utf8" }),
    ),
  ).toEqual({ leases: 0, inputs: 0, requests: 0 });
});

test("Browser release recovery starts only the original writer identities", () => {
  const script = `${load}
with tempfile.TemporaryDirectory() as root:
 root=Path(root);calls=root/'calls';fake=root/'engine.py'
 fake.write_text("import json,sys\\nfrom pathlib import Path\\ncalls=Path(sys.argv[1]);args=sys.argv[2:];calls.open('a').write(json.dumps(args)+'\\\\n')\\nif args[0]=='inspect':print(json.dumps([{'Id':'original','Image':'old-image','State':{'Status':'exited'}}]))\\n")
 baseline={'containers':{'repodesk-app-1':{'id':'original','image':'old-image'}}}
 runtime.start_unchanged_writers(baseline,['app'],engine=[sys.executable,str(fake),str(calls)])
 assert json.loads(calls.read_text().splitlines()[-1])==['start','original']
 calls.write_text('');baseline['containers']['repodesk-app-1']['id']='replacement'
 try:runtime.start_unchanged_writers(baseline,['repodesk-app-1'],engine=[sys.executable,str(fake),str(calls)])
 except AssertionError:pass
 else:raise AssertionError('A changed writer was restarted')
 assert len(calls.read_text().splitlines())==1
 print('recovery_fenced')
`;
  expect(
    execFileSync("python3", ["-c", script, modulePath], {
      encoding: "utf8",
    }).trim(),
  ).toBe("recovery_fenced");
});

test("Browser release resume retains the original host backup and rejects tampering", () => {
  const script = `${load}
import hashlib
with tempfile.TemporaryDirectory() as root:
 root=Path(root);installed=root/'installed';backup=root/'backup';installed.mkdir()
 def write(value):
  (installed/'host.js').write_text(value)
  (installed/'manifest.json').write_text(json.dumps({'host.js':hashlib.sha256(value.encode()).hexdigest()}))
 write('original');runtime.preserve_host_backup(installed,backup)
 write('replacement');runtime.preserve_host_backup(installed,backup)
 assert (backup/'host.js').read_text()=='original'
 (backup/'host.js').write_text('tampered')
 try:runtime.preserve_host_backup(installed,backup)
 except AssertionError:pass
 else:raise AssertionError('A corrupt host backup was accepted')
 print('original_backup_retained')
`;
  expect(
    execFileSync("python3", ["-c", script, modulePath], {
      encoding: "utf8",
    }).trim(),
  ).toBe("original_backup_retained");
});
