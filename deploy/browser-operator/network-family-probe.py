"""Public transport metadata only. Suppress verbose curl and all proxy credentials."""
import json,socket,subprocess
host='www.youtube.com'
print(json.dumps({'youtubeDns': [{'family':a[0],'address':a[4][0]} for a in socket.getaddrinfo(host,443,type=socket.SOCK_STREAM)]}))
for family in ['-4','-6']:
 for route in ['default','direct']:
  args=['curl',family,'--silent','--output','/dev/null','--max-time','12','--write-out','%{http_code} %{remote_ip} %{time_total}']
  if route=='direct':args+=['--noproxy','*']
  r=subprocess.run(args+['https://www.youtube.com/@mdddj/videos'],capture_output=True,text=True)
  print(json.dumps({'familyProbe':family,'route':route,'exit':r.returncode,'metrics':r.stdout}))
