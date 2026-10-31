import { operator } from "../admin/auth.ts";
import type { Store } from "../db/repositories.ts";
import { type Admin, requireThat, type Workspace } from "../domain.ts";
import type { GitHubApps } from "../github/registry.ts";
import { encrypt } from "../setup/credentials.ts";
import { audit } from "../workspaces/policy.ts";
import {
  type CodingPage,
  codingSaveSchema,
  codingSettingsSchema,
  emptyCoding,
} from "./config.ts";
import { DevelopmentExecutor } from "./executor.ts";
import type { LocalDeviceAuth, LocalRunner } from "./local/protocol.ts";

function operatorWorkspace(w: Workspace, admin: Admin) {
  operator(admin);
  requireThat(w.operatorId === admin.id && !w.deletion, "access_denied", 403);
}
export function codingView(w: Workspace, admin: Admin): CodingPage {
  operatorWorkspace(w, admin);
  const settings = w.coding?.settings ?? emptyCoding;
  return {
    providerApiKeyConfigured: !!w.coding?.providerApiKey,
    legacyActionsConfiguration: !!w.coding && settings.backend !== "podman",
    revision: w.coding?.revision ?? 0,
    settings: codingSettingsSchema.parse({ ...settings, backend: "podman" }),
    repositories: w.github?.installationId ? w.github.repositories : [],
    tasks: [],
  };
}
export function saveCoding(
  w: Workspace,
  admin: Admin,
  value: unknown,
  encryptionKey?: string,
) {
  operatorWorkspace(w, admin);
  const input = codingSaveSchema.parse(value);
  requireThat(
    input.revision === (w.coding?.revision ?? 0),
    "version_conflict",
    409,
  );
  if (input.settings.model)
    requireThat(
      input.providerApiKey === undefined,
      "provider_credentials_managed_centrally",
    );
  let providerApiKey = input.settings.model
    ? undefined
    : w.coding?.providerApiKey;
  if (input.providerApiKey === null) providerApiKey = undefined;
  else if (input.providerApiKey !== undefined) {
    requireThat(encryptionKey, "coding_credentials_unavailable", 503);
    providerApiKey = encrypt(
      encryptionKey,
      `coding-provider:${w.id}`,
      input.providerApiKey,
    );
  }
  w.coding = {
    revision: input.revision + 1,
    settings: input.settings,
    providerApiKey,
  };
  audit(w, admin.id, "coding.settings_updated", w.id, w.coding.revision);
  return codingView(w, admin);
}
/** Every irreversible operation has a committed reservation; none is replayed. */
export class CodingService {
  constructor(
    private store: Store,
    private apps: GitHubApps,
    private local?: LocalRunner,
    private encryptionKey?: string,
    private browser?: import("../browser/codex.ts").CodexBrowsers,
  ) {}
  async purgeDeletedWorkspaceAuth(workspaceId: string) {
    const w = await this.store.read(workspaceId);
    requireThat(w.deletion, "deletion_not_requested", 409);
    const device = this.local as
      | (LocalRunner & Partial<LocalDeviceAuth>)
      | undefined;
    if (!device?.deviceLogout) return false;
    await device.deviceLogout(workspaceId);
    return true;
  }
  async tick(workspaceId: string) {
    await new DevelopmentExecutor(
      this.store,
      this.apps,
      this.local,
      this.encryptionKey,
      undefined,
      undefined,
      this.browser,
    ).tick(workspaceId);
  }
}
