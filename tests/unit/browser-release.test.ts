import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const modulePath = fileURLToPath(
  new URL("../../deploy/browser-operator/update_runtime.py", import.meta.url),
);
const load = `import importlib.util,json,sys,tempfile\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('update_runtime',sys.argv[1]);runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)\n`;

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
 runtime.start_unchanged_writers(baseline,['repodesk-app-1'],engine=[sys.executable,str(fake),str(calls)])
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
