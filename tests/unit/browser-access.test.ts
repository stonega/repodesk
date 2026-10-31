import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  browserGrantPolicy,
  decideBrowserAccess,
  emptyBrowserAccess,
  grantBrowserSite,
  invalidateBrowserAccess,
  requestBrowserAccess,
} from "../../src/browser/access.ts";

const controller = { kind: "chat" as const, id: randomUUID(), fence: 1 };
function request() {
  const access = emptyBrowserAccess();
  const pending = requestBrowserAccess(
    access,
    {
      controller,
      configuration: 2,
      epoch: 3,
      operationId: "call",
      kind: "site",
      origin: "https://example.com",
      preview: false,
    },
    100,
  );
  return { access, pending };
}
test("browser site authority starts empty and is bound to consumer, configuration, owner epoch and expiry", () => {
  const { access, pending } = request();
  expect(browserGrantPolicy(access, controller, 2, 3, 101).origins).toEqual([]);
  decideBrowserAccess(access, pending.id, true, 2, 3, 101);
  const saved = access.requests[0];
  if (!saved) throw Error("missing fixture");
  saved.state = "applying";
  grantBrowserSite(access, saved, 102);
  expect(
    browserGrantPolicy(access, { ...controller, fence: 2 }, 2, 3, 103).origins,
  ).toEqual(["https://example.com"]);
  for (const [consumer, configuration, epoch, now] of [
    [{ ...controller, id: randomUUID() }, 2, 3, 103],
    [controller, 3, 3, 103],
    [controller, 2, 4, 103],
    [controller, 2, 3, 2_000_000],
  ] as const)
    expect(
      browserGrantPolicy(access, consumer, configuration, epoch, now).origins,
    ).toEqual([]);
});
test("permission decisions reject foreign, expired, changed and conflicting submissions", () => {
  const { access, pending } = request();
  expect(() =>
    decideBrowserAccess(access, randomUUID(), true, 2, 3, 101),
  ).toThrow("browser_request_unavailable");
  expect(() =>
    decideBrowserAccess(access, pending.id, true, 3, 3, 101),
  ).toThrow("browser_configuration_changed");
  expect(() =>
    decideBrowserAccess(access, pending.id, true, 2, 3, pending.expiresAt),
  ).toThrow("browser_request_expired");
  decideBrowserAccess(access, pending.id, false, 2, 3, 101);
  expect(() =>
    decideBrowserAccess(access, pending.id, true, 2, 3, 102),
  ).toThrow("browser_request_unavailable");
});
test("revoking access cancels untouched requests and retains uncertain outcomes", () => {
  const { access } = request();
  const pending = access.requests[0];
  if (!pending) throw Error("missing fixture");
  pending.state = "applying";
  invalidateBrowserAccess(access);
  expect(access.requests[0]?.state).toBe("unknown");
  expect(access.grants).toEqual([]);
});
test("a request cannot be substituted under the same consumer operation ID", () => {
  const { access } = request();
  expect(() =>
    requestBrowserAccess(
      access,
      {
        controller,
        configuration: 2,
        epoch: 3,
        operationId: "call",
        kind: "site",
        origin: "https://another.example",
        preview: false,
      },
      101,
    ),
  ).toThrow("browser_duplicate_conflict");
});
