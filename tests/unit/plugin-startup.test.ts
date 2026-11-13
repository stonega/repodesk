import { expect, test } from "bun:test";
import {
  pluginStartupCases,
  verifyPluginStartup,
} from "../../scripts/fixtures/plugin-startup.ts";

test("all production plugin factories can answer a greeting with failed optional dependencies", async () => {
  expect(await verifyPluginStartup()).toBe(pluginStartupCases.length * 2);
});

test("the configured API and worker plugin graph stays offline during a greeting", async () => {
  expect(await verifyPluginStartup("configured")).toBe(
    pluginStartupCases.length * 2,
  );
});
