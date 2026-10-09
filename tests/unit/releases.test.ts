import { expect, test } from "bun:test";
import { newerRelease } from "../../src/updates/releases.ts";

test("release comparisons use numeric stable versions and never downgrade", () => {
  for (const tag of ["v0.1.33", "0.2.0", "v0.10.0", "1.0.0"])
    expect(newerRelease(tag, "0.1.32")).toBe(true);
  for (const tag of [
    "v0.1.32",
    "0.1.9",
    "v0.1.33-beta.1",
    "nightly",
    "v00.2.0",
  ])
    expect(newerRelease(tag, "0.1.32")).toBe(false);
  expect(newerRelease("0.1.33", "development")).toBe(false);
});
