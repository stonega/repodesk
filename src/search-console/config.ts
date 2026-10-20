import { z } from "zod";

export const searchConsoleTool = "query_search_console";
export const propertyUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    if (/^sc-domain:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value))
      return true;
    try {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, "Use an exact Search Console property URL or sc-domain:example.com.");
export const searchConsoleSettings = z
  .object({
    enabled: z.boolean(),
    siteUrls: z
      .array(propertyUrl)
      .max(20)
      .refine((urls) => new Set(urls).size === urls.length),
  })
  .strict();
export const emptySearchConsole = { enabled: false, siteUrls: [] as string[] };
export const searchConsoleSave = z
  .object({
    revision: z.number().int().nonnegative(),
    settings: searchConsoleSettings,
    serviceAccount: z.string().trim().min(1).max(20000).optional(),
    removeCredential: z.boolean().optional(),
  })
  .strict()
  .refine((v) => !(v.serviceAccount && v.removeCredential));
export const serviceAccountSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.email().max(320).endsWith(".gserviceaccount.com"),
  private_key: z.string().min(100).max(16000),
});
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;
export interface SearchConsoleConfig {
  settings: z.infer<typeof searchConsoleSettings>;
  credential?: string;
  email?: string;
}
export interface SearchConsolePage {
  revision: number;
  settings: z.infer<typeof searchConsoleSettings>;
  credentialConfigured: boolean;
  email?: string;
}
export const searchDimensions = [
  "date",
  "query",
  "page",
  "country",
  "device",
  "searchAppearance",
] as const;
const date = z.iso.date();
export const searchConsoleQuery = z
  .object({
    resource: z.enum(["properties", "analytics", "sitemaps", "inspect_url"]),
    siteUrl: propertyUrl.optional(),
    startDate: date.optional(),
    endDate: date.optional(),
    dimensions: z
      .array(z.enum(searchDimensions))
      .max(6)
      .refine((v) => new Set(v).size === v.length)
      .default([]),
    type: z
      .enum(["web", "image", "video", "news", "discover", "googleNews"])
      .default("web"),
    rowLimit: z.number().int().min(1).max(100).default(25),
    startRow: z.number().int().min(0).max(50000).default(0),
    inspectionUrl: z.url().max(2048).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.resource !== "properties" && !v.siteUrl)
      ctx.addIssue({
        code: "custom",
        path: ["siteUrl"],
        message: "Choose a saved property.",
      });
    if (
      v.resource === "analytics" &&
      (!v.startDate ||
        !v.endDate ||
        v.endDate < v.startDate ||
        Date.parse(v.endDate) - Date.parse(v.startDate) > 365 * 86400000)
    )
      ctx.addIssue({
        code: "custom",
        path: ["startDate"],
        message: "Choose a date range of at most 366 days.",
      });
    if (v.resource === "inspect_url" && !v.inspectionUrl)
      ctx.addIssue({
        code: "custom",
        path: ["inspectionUrl"],
        message: "Enter a URL to inspect.",
      });
  });

export function inspectionInProperty(site: string, value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    return false;
  if (site.startsWith("sc-domain:")) {
    const domain = site.slice(10).toLowerCase();
    return url.hostname === domain || url.hostname.endsWith(`.${domain}`);
  }
  return url.href.startsWith(new URL(site).href);
}
