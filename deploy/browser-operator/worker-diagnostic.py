import json,re,sys
from pathlib import Path
root=Path(sys.argv[1])
for name in ['repodesk-app-1','repodesk-worker-1']:
 p=root/(name+'-failed-startup.log')
 if not p.exists():continue
 raw=p.read_text()
 print(json.dumps({'container':name,'errorClasses':sorted(set(re.findall(r'(?m)^(\w*Error|Fault):',raw))),'fixedErrors':sorted(set(re.findall(r'(?m)^(?:Error|Fault): ([a-z][a-z0-9_]{3,100})$',raw))),'stackFrames':list(dict.fromkeys(re.findall(r'/app/(?:dist|node_modules)/[A-Za-z0-9@._/+:-]+:[0-9]+:[0-9]+',raw)))[:10],'configPaths':list(dict.fromkeys(re.findall(r'"path":\s*\[\s*"([A-Z][A-Z0-9_]{2,80})"',raw)))[:20],'diagnosticCodes':sorted(set(re.findall(r'(?i)(?<![a-z_])(?:EACCES|ENOENT|ECONNREFUSED|ENOTFOUND|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|42P01|42703|28P01)(?![a-z_])',raw)))}))
