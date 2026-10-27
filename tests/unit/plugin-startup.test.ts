import { expect, test } from "bun:test";
import {
  pluginStartupCases,
  verifyPluginStartup,
} from "../../scripts/fixtures/plugin-startup.ts";

test("all production plugin factories can answer a greeting with failed optional dependencies", async () => {
  expect(await verifyPluginStartup()).toBe(pluginStartupCases.length * 2);
});
