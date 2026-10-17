import { z } from "zod";

export const runtimeEngine = z.enum(["docker", "opensandbox"]);
export type RuntimeEngine = z.infer<typeof runtimeEngine>;
export const runtimeNames: Record<RuntimeEngine, string> = {
  docker: "Docker",
  opensandbox: "OpenSandbox",
};
export const runtimeSave = z
  .object({
    revision: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 1),
    selection: runtimeEngine.nullable(),
  })
  .strict();
export const runtimeView = z
  .object({
    revision: z.number().int().nonnegative(),
    selection: runtimeEngine.nullable(),
    engine: runtimeEngine,
    environmentDefault: runtimeEngine,
    retainedTasks: z.number().int().nonnegative(),
  })
  .strict();
export type RuntimeView = z.infer<typeof runtimeView>;
export type RuntimeSave = z.infer<typeof runtimeSave>;
export interface LocalRuntimeControl {
  runtimeStatus(): Promise<RuntimeView>;
  runtimeSave(input: RuntimeSave): Promise<RuntimeView>;
}
