import { z } from "zod";
import type { Capability, JsonObject } from "./contract.ts";
import type { PackageSource } from "./github-source.ts";
import type { PluginManifest } from "./manifest.ts";

export interface PackageArtifact {
  guides?: import("./package-skills.ts").PackageGuide[];
  manifest: PluginManifest;
  source: PackageSource;
  digest: string;
  bundleHash: string;
  manifestHash: string;
}
export interface PackageConnection {
  id: string;
  actor?: string;
  encrypted?: string;
  revision: number;
  members: string[];
  privateOnly: boolean;
  chats: string[];
}
export interface PackageInstallation extends PackageArtifact {
  generation: number;
  enabled: boolean;
  settings: JsonObject;
  grants: Capability[];
  history: PackageArtifact[];
  connections: PackageConnection[];
}
export type PublicPackageInstallation = Omit<
  PackageInstallation,
  "connections"
> & {
  connections: (Omit<PackageConnection, "encrypted"> & {
    configured: boolean;
  })[];
};
export interface PackageCatalog {
  revision: number;
  configured: boolean;
  runnerConfigured: boolean;
  entries: PublicPackageInstallation[];
  members: { id: string; name: string }[];
  chats: { id: string; name: string }[];
}
export interface PackagePreview extends PackageArtifact {
  id: string;
  actor: string;
  revision: number;
  expiresAt: string;
  intent: "install" | "update" | "rollback";
  requestId: string;
  requestHash: string;
  consumed?: boolean;
  generation?: number;
  sourceConnection?: {
    installationId: number;
    repositoryId: number;
    revision: number;
  };
}
export const previewInput = z
  .object({
    url: z.string().min(1).max(256),
    ref: z.string().min(1).max(100).optional(),
    revision: z.number().int().min(0),
    requestId: z.string().uuid(),
    intent: z.enum(["install", "update", "rollback"]),
  })
  .strict();
export const applyInput = z
  .object({ previewId: z.string().uuid(), revision: z.number().int().min(0) })
  .strict();
export const packageUpdateInput = z
  .object({
    revision: z.number().int().min(0),
    enabled: z.boolean(),
    settings: z.record(z.string(), z.json()),
    grants: z.array(z.enum(["github.metadata.read", "http.read"])).max(2),
  })
  .strict();
export const packageConnectionInput = z
  .object({
    revision: z.number().int().min(0),
    id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
    token: z.string().min(1).max(8192).optional(),
    disconnect: z.boolean().default(false),
    members: z.array(z.string().regex(/^[1-9]\d{0,15}$/)).max(500),
    privateOnly: z.boolean(),
    chats: z.array(z.string().regex(/^-[1-9]\d{0,15}$/)).max(100),
  })
  .strict();
