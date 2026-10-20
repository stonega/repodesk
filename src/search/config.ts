import { z } from "zod";

export const searchTypes = ["duckduckgo", "deepseek", "exa"] as const;
export type SearchType = (typeof searchTypes)[number];
export const searchLabels: Record<SearchType, string> = {
  duckduckgo: "DuckDuckGo (free)",
  deepseek: "DeepSeek",
  exa: "Exa",
};
export interface SearchProvider {
  id: string;
  operatorId: string;
  version: number;
  name: string;
  type: SearchType;
  credential?: string;
}
export type SearchProviderView = Omit<
  SearchProvider,
  "operatorId" | "credential"
> & {
  apiKeyConfigured: boolean;
};
export interface SearchCatalog {
  version: number;
  providers: SearchProviderView[];
}
export const searchInput = z
  .object({
    version: z.number().int().positive(),
    id: z.uuid().optional(),
    name: z.string().trim().min(1).max(100),
    type: z.enum(searchTypes),
    apiKey: z.string().trim().min(1).max(8192).optional(),
  })
  .strict();
export interface SearchPin {
  id: string;
  operatorId: string;
  version: number;
  type: SearchType;
  chatRevision: number;
}
