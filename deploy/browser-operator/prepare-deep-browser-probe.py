"""Copy the worker only for an isolated diagnostic process; retain no raw errors."""
from pathlib import Path
import sys
source=Path('src/browser/browser-host-worker.ts').read_text()
source=source.replace('error instanceof Fault ? error.code : "browser_execution_failed"', '''error instanceof Fault ? error.code : error instanceof Error && error.name === "TimeoutError" ? "browser_probe_timeout" : error instanceof Error && error.name === "ZodError" ? "browser_probe_checkpoint_schema" : error instanceof Error && /net::ERR_HTTP2_PROTOCOL_ERROR/.test(error.message) ? "browser_probe_http_two_protocol" : error instanceof Error && /net::ERR_CERT_/.test(error.message) ? "browser_probe_certificate" : error instanceof Error && /net::ERR_TUNNEL_CONNECTION_FAILED/.test(error.message) ? "browser_probe_tunnel" : error instanceof Error && /net::ERR_CONNECTION_RESET/.test(error.message) ? "browser_probe_connection_reset" : error instanceof Error && /net::ERR_ABORTED/.test(error.message) ? "browser_probe_aborted" : "browser_probe_unclassified"''')
# Keep relative imports rooted next to the original, without modifying it.
Path('src/browser/incident-diagnostic-worker.ts').write_text(source)
egress=Path('src/browser/egress.ts').read_text()
egress=egress.replace("const destination = await browserDestination(url, policy, this.resolve);",'''const destination = await browserDestination(url, policy, this.resolve);
    if(url.hostname === "www.youtube.com") console.log(JSON.stringify({egressProbe:"destination",address:destination.address,family:destination.family,port:destination.port}));''')
egress=egress.replace('upstream.on("error", () => client.destroy());','''upstream.on("error", (error) => { console.log(JSON.stringify({egressProbe:"connect_error",code:["ECONNREFUSED","ECONNRESET","ETIMEDOUT","ENETUNREACH","EHOSTUNREACH","EADDRNOTAVAIL","ENOTFOUND"].includes(error.code ?? "")?error.code:"network_error"}));client.destroy();});''')
egress=egress.replace('''      } catch {
        client.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n");''','''      } catch (error) {
        console.log(JSON.stringify({egressProbe:"denied",code:error instanceof Error && /^browser_[a-z_]+$/.test(error.message)?error.message:"invalid_destination"}));
        client.end("HTTP/1.1 403 Forbidden\\r\\n\\r\\n");''')
Path('src/browser/incident-diagnostic-egress.ts').write_text(egress)
runtime=Path('src/browser/host-runtime.ts').read_text().replace('"./egress.ts"','"./incident-diagnostic-egress.ts"')
Path('src/browser/incident-diagnostic-runtime.ts').write_text(runtime)
egress=Path('src/browser/incident-diagnostic-egress.ts').read_text()
egress=egress.replace('family:destination.family,port:destination.port}', 'family:destination.family,port:destination.port,policyUnchanged:policy===this.policy}')
start=egress.index('    server.on("connect",')
end=egress.index('    server.on("upgrade",',start)
section=egress[start:end]
section=section.replace('      try {','      let phase="authority";\n      try {',1)
section=section.replace('        const target = await this.destination(new URL(origin));','        phase="resolve";\n        const target = await this.destination(new URL(origin));\n        console.log(JSON.stringify({egressProbe:"client_state",destroyed:client.destroyed}));\n        phase="client_state";')
section=section.replace('        const upstream = connect({','        phase="connect";\n        const upstream = connect({')
section=section.replace('        upstream.once("connect", () => {','        upstream.once("connect", () => { console.log(JSON.stringify({egressProbe:"tunnel_open"}));')
section=section.replace('egressProbe:"denied",code:', 'egressProbe:"denied",phase,code:')
egress=egress[:start]+section+egress[end:]
Path('src/browser/incident-diagnostic-egress.ts').write_text(egress)

probe=Path("deploy/browser-operator/deep-browser-probe.ts").read_text().replace("../../src/browser/host-runtime.ts", "../../src/browser/incident-diagnostic-runtime.ts")
Path("deploy/browser-operator/incident-native-probe.ts").write_text(probe)
