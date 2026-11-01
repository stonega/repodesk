import { z } from "zod";

const absolute = z.string().startsWith("/").max(2048);
export const browserHostSettings = z.object({
  BROWSER_HOST_ROOT: absolute.default("/var/lib/repodesk-browser"),
  BROWSER_HOST_SOCKET: absolute.default("/run/repodesk-browser/control.sock"),
  BROWSER_HOST_TOKEN_FILE: absolute.default("/etc/repodesk/browser-token"),
  BROWSER_EXECUTABLE: absolute.default("/usr/bin/google-chrome"),
  BROWSER_HOST_SOCKET_GID: z.coerce
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1)
    .default(1000),
  BROWSER_HOST_MAX_PROCESSES: z.coerce.number().int().min(1).max(32).default(4),
  BROWSER_HOST_IDLE_SECONDS: z.coerce
    .number()
    .int()
    .min(30)
    .max(86400)
    .default(300),
});
export type BrowserHostSettings = z.infer<typeof browserHostSettings>;
