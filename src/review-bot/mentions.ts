export function reviewMention(
  body: string,
  handle: string,
):
  | { mode: "review" | "answer" | "fix" | "status" | "cancel"; text: string }
  | undefined {
  // Only a directly addressed line can authorize work; quoted/code text is data.
  let fence: string | undefined;
  const bodyLines = body.split(/\r?\n/);
  for (const [index, line] of bodyLines.entries()) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (delimiter) {
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length)
        fence = undefined;
      continue;
    }
    if (fence || /^(?:\s*>| {4}|\t)/.test(line)) continue;
    const text = line.trim();
    const prefix = [handle, handle.replace(/\[bot\]$/, "")]
      .map((name) => `@${name}`)
      .find(
        (candidate) =>
          text.toLowerCase().startsWith(candidate.toLowerCase()) &&
          (!text.slice(candidate.length) ||
            /^[\s,:]/.test(text.slice(candidate.length))),
      );
    if (!prefix) continue;
    const rest = text.slice(prefix.length);
    if (rest && !/^[\s,:]/.test(rest)) continue;
    const request = rest.replace(/^[\s,:]+/, "").trim();
    if (!request) return { mode: "review", text: "Review this pull request." };
    const command = request.split(/\s/)[0]?.toLowerCase();
    const mode =
      command === "cancel" || command === "stop"
        ? "cancel"
        : command === "status"
          ? "status"
          : command === "review" || command === "rereview"
            ? "review"
            : /^(?:(?:please|can you|could you|would you)\s+)?(?:fix|implement|finish|address)\b/i.test(
                  request,
                )
              ? "fix"
              : "answer";
    return {
      mode,
      text: [request, ...bodyLines.slice(index + 1)].join("\n").trim(),
    };
  }
  return undefined;
}
