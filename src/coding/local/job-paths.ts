/** Only the trusted native runner sets these roots; containers keep their paths. */
export function jobPath(path: string) {
  const match = path.match(/^\/(task|input|auth)(?=\/|$)/);
  if (!match) throw Error("coding_artifact_invalid");
  const root = process.env[`REPODESK_${match[1]?.toUpperCase()}_ROOT`];
  return root ? root + path.slice(match[0].length) : path;
}
