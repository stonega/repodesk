import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type BrowserContext,
  chromium,
  type ElementHandle,
  type Page,
} from "playwright-core";
import { Fault, requireThat } from "../domain.ts";
import { browserLimits } from "./config.ts";
import {
  type BrowserArtifact as Artifact,
  browserArtifacts,
  readBrowserArtifact,
  saveBrowserArtifact,
} from "./host-artifacts.ts";
import {
  type BrowserCheckpoint,
  browserCheckpoint,
} from "./host-checkpoint.ts";
import type { BrowserHostPolicy, HostCommand, HostResult } from "./protocol.ts";

type Tab = { id: string; page: Page; revision: number };
const fieldIdentity = (element: Element) =>
  JSON.stringify([
    element.tagName,
    ...["id", "name", "type", "autocomplete"].map((name) =>
      element.getAttribute(name),
    ),
  ]);
export interface HostPageOptions {
  home: string;
  executable: string;
  proxy: { server: string; username: string; password: string };
  env: Record<string, string>;
  checkpoint?: BrowserCheckpoint;
}

/** This object lives only in the owner's unprivileged worker process. */
export class HeadedBrowser {
  private context?: BrowserContext;
  private tabs = new Map<string, Tab>();
  private selected?: string;
  private artifacts: Artifact[] = [];
  private pendingDownloads = 0;
  private secrets = new Set<string>();
  private blockedOrigins = new Set<string>();
  private input?: {
    pageId: string;
    revision: number;
    origin: string;
    selector: string;
    field: ElementHandle<SVGElement | HTMLElement>;
    identity: string;
    expiresAt: number;
  };
  private policy: BrowserHostPolicy = {
    origins: [],
    previewOrigins: [],
    interact: false,
  };
  constructor(private options: HostPageOptions) {}
  async start() {
    requireThat(
      process.getuid?.() !== 0 &&
        this.options.env.DISPLAY &&
        this.options.env.XAUTHORITY,
      "browser_display_unavailable",
      503,
    );
    const artifacts = join(this.options.home, "artifacts");
    await mkdir(artifacts, { recursive: true, mode: 0o700 });
    this.artifacts = await browserArtifacts(this.options.home);
    this.context = await chromium
      .launchPersistentContext(join(this.options.home, "profile"), {
        executablePath: this.options.executable,
        headless: false,
        chromiumSandbox: true,
        viewport: { width: 1280, height: 800 },
        acceptDownloads: true,
        downloadsPath: join(this.options.home, "temporary-downloads"),
        env: this.options.env,
        proxy: { ...this.options.proxy, bypass: "<-loopback>" },
        args: [
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
        timeout: 20_000,
      })
      .catch(() => {
        throw new Fault("browser_launch_failed", 503);
      });
    const control = await this.context.browser()?.newBrowserCDPSession();
    requireThat(control, "browser_service_unavailable", 503);
    await control.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: join(this.options.home, "temporary-downloads"),
      eventsEnabled: true,
    });
    control.on("Browser.downloadProgress", (event) => {
      if (
        event.state === "inProgress" &&
        Math.max(event.totalBytes, event.receivedBytes) >
          browserLimits.downloadBytes
      )
        void control
          .send("Browser.cancelDownload", { guid: event.guid })
          .catch(() => {});
    });
    this.context.setDefaultTimeout(10_000);
    if (this.options.checkpoint?.cookies.length)
      await this.context.addCookies(this.options.checkpoint.cookies);
    await this.context.route("**/*", async (route) => {
      try {
        const request = route.request(),
          url = new URL(request.url());
        if (!["http:", "https:"].includes(url.protocol)) {
          await route.abort();
          return;
        }
        if (!this.policy.origins.includes(url.origin)) {
          if (this.blockedOrigins.size < 32)
            this.blockedOrigins.add(url.origin);
          await route.abort();
          return;
        }
        await route.continue();
      } catch {
        await route.abort().catch(() => {});
      }
    });
    this.context.on("page", (page) => this.addPage(page));
    for (const page of this.context.pages()) this.addPage(page);
    if (!this.tabs.size) this.addPage(await this.context.newPage());
  }
  private addPage(page: Page) {
    if ([...this.tabs.values()].some((tab) => tab.page === page)) return;
    if (this.tabs.size >= browserLimits.tabs) {
      void page.close().catch(() => {});
      return;
    }
    const tab = { id: randomUUID(), page, revision: 0 };
    this.tabs.set(tab.id, tab);
    this.selected ??= tab.id;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        tab.revision++;
        this.clearInput();
      }
    });
    page.on("close", () => {
      this.tabs.delete(tab.id);
      if (this.selected === tab.id)
        this.selected = this.tabs.keys().next().value;
    });
    page.on("dialog", (dialog) => void dialog.dismiss().catch(() => {}));
    // Intercept native file choosers without exposing host paths to consumers.
    page.on(
      "filechooser",
      (chooser) => void chooser.setFiles([]).catch(() => {}),
    );
    page.on("download", (download) => {
      this.pendingDownloads++;
      void (async () => {
        const origin = new URL(page.url()).origin;
        if (
          !this.policy.interact ||
          !this.policy.origins.includes(origin) ||
          this.artifacts.filter(
            (a) =>
              a.mimeType === "application/octet-stream" &&
              a.at > Date.now() - 24 * 3600_000,
          ).length +
            this.pendingDownloads >
            browserLimits.downloads
        ) {
          await download.cancel();
          return;
        }
        const path = await download.path();
        requireThat(path, "browser_download_failed", 409);
        const size = (await stat(path)).size;
        if (size > browserLimits.downloadBytes) {
          await download.delete();
          return;
        }
        const artifact: Artifact = {
          id: randomUUID(),
          name:
            this.clean(download.suggestedFilename())
              .split("")
              .map((character) =>
                character.charCodeAt(0) < 32 ||
                character.charCodeAt(0) === 127 ||
                "/\\".includes(character)
                  ? "_"
                  : character,
              )
              .join("")
              .slice(0, 160) || "download",
          size,
          mimeType: "application/octet-stream",
          origin,
          at: Date.now(),
        };
        await download.saveAs(
          join(this.options.home, "artifacts", artifact.id),
        );
        await this.saveArtifact(artifact);
      })()
        .catch(() => {})
        .finally(() => {
          this.pendingDownloads--;
        });
    });
  }
  setPolicy(policy: BrowserHostPolicy) {
    this.policy = structuredClone(policy);
    for (const origin of this.blockedOrigins)
      if (policy.origins.includes(origin)) this.blockedOrigins.delete(origin);
  }
  private clearInput() {
    const field = this.input?.field;
    this.input = undefined;
    void field?.dispose().catch(() => {});
  }
  private tab() {
    const tab = this.selected && this.tabs.get(this.selected);
    requireThat(tab, "browser_page_unavailable", 409);
    return tab;
  }
  private allowed(tab: Tab) {
    const url = new URL(tab.page.url());
    requireThat(
      this.policy.origins.includes(url.origin),
      "browser_destination_denied",
      403,
    );
    return url.origin;
  }
  private clean(text: string) {
    for (const value of this.secrets)
      text = text.split(value).join("[redacted]");
    return text;
  }
  private async saveArtifact(artifact: Artifact) {
    await saveBrowserArtifact(this.options.home, artifact);
    this.artifacts = await browserArtifacts(this.options.home);
  }
  private pageStatus(tab: Tab) {
    return { id: tab.id, revision: tab.revision, origin: this.allowed(tab) };
  }
  async execute(
    command: HostCommand,
    policy = this.policy,
  ): Promise<HostResult> {
    requireThat(this.context, "browser_service_unavailable", 503);
    if (command.command === "observe") {
      const previous = this.policy;
      this.policy = policy;
      try {
        return await this.execute(
          { command: "action", input: { action: command.view } },
          policy,
        );
      } finally {
        this.policy = previous;
      }
    }
    if (command.command === "release") {
      this.clearInput();
      this.blockedOrigins.clear();
      this.setPolicy({ origins: [], previewOrigins: [], interact: false });
      return { status: "ready", headed: true };
    }
    if (command.command === "status" || command.command === "acquire")
      return {
        status: "ready",
        headed: true,
        downloads: this.artifacts
          .filter(
            (item) =>
              item.mimeType === "application/octet-stream" &&
              policy.origins.includes(item.origin) &&
              item.at > Date.now() - 24 * 3600_000,
          )
          .map(({ id, name, size }) => ({ id, name, size })),
      };
    if (command.command === "artifact") {
      return readBrowserArtifact(this.options.home, command.id, policy);
    }
    if (command.command === "input") {
      const tab = this.tab(),
        pending = this.input;
      requireThat(
        pending &&
          pending.expiresAt > Date.now() &&
          pending.pageId === command.pageId &&
          pending.revision === command.pageRevision &&
          pending.origin === command.origin &&
          pending.selector === command.selector &&
          tab.id === command.pageId &&
          tab.revision === command.pageRevision &&
          this.allowed(tab) === command.origin,
        "browser_page_changed",
        409,
      );
      requireThat(
        (await pending.field.isVisible()) &&
          (await pending.field.isEditable()) &&
          (await pending.field.evaluate(fieldIdentity)) === pending.identity &&
          new URL((await pending.field.ownerFrame())?.url() ?? "about:blank")
            .origin === command.origin,
        "browser_page_changed",
        409,
      );
      this.secrets.add(command.value);
      await pending.field.fill(command.value);
      this.clearInput();
      return { status: "completed", page: this.pageStatus(tab) };
    }
    requireThat(command.command === "action", "browser_action_invalid", 400);
    const action = command.input;
    requireThat(
      action.action !== "request_site",
      "browser_action_invalid",
      400,
    );
    if (command.page) {
      const tab = this.tab();
      requireThat(
        tab.id === command.page.id &&
          tab.revision === command.page.revision &&
          this.allowed(tab) === command.page.origin,
        "browser_page_changed",
        409,
      );
    }
    if (
      this.input &&
      this.input.expiresAt > Date.now() &&
      !["tabs", "read", "screenshot"].includes(action.action)
    )
      throw new Fault("browser_input_pending", 409);
    if (["click", "fill", "press", "pointer"].includes(action.action))
      requireThat(
        this.policy.interact,
        "browser_action_approval_required",
        403,
      );
    if (action.action === "new_tab") {
      requireThat(this.tabs.size < browserLimits.tabs, "browser_capacity", 409);
      const page = await this.context.newPage();
      this.addPage(page);
      this.selected = [...this.tabs.values()].find(
        (tab) => tab.page === page,
      )?.id;
      return { status: "completed" };
    }
    if (action.action === "tabs") {
      const tabs = [];
      for (const tab of this.tabs.values()) {
        const url = new URL(tab.page.url());
        if (
          url.href !== "about:blank" &&
          !this.policy.origins.includes(url.origin)
        )
          continue;
        tabs.push({
          id: tab.id,
          title: this.clean(
            await tab.page.evaluate(() => document.title.slice(0, 200 + 4096)),
          ).slice(0, 200),
          url:
            url.href === "about:blank"
              ? "about:blank"
              : this.clean(`${url.origin}${url.pathname}`),
        });
      }
      return { status: "completed", tabs };
    }
    if (action.action === "select_tab" || action.action === "close_tab") {
      const tab = this.tabs.get(action.tabId);
      requireThat(tab, "browser_page_unavailable", 404);
      if (tab.page.url() !== "about:blank") this.allowed(tab);
      if (action.action === "close_tab") await tab.page.close();
      else {
        this.selected = tab.id;
        await tab.page.bringToFront();
      }
      return { status: "completed" };
    }
    const tab = this.tab();
    if (action.action === "navigate") {
      requireThat(
        this.policy.origins.includes(new URL(action.url).origin),
        "browser_destination_denied",
        403,
      );
      try {
        await tab.page.goto(action.url, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });
      } catch (error) {
        if (this.blockedOrigins.size)
          return {
            status: "unavailable",
            blockedOrigins: [...this.blockedOrigins],
          };
        throw error;
      }
      return { status: "completed", page: this.pageStatus(tab) };
    }
    this.allowed(tab);
    if (action.action === "read") {
      const controls = await tab.page
        .locator('a,button,input,select,textarea,[role="button"]')
        .evaluateAll((elements) =>
          elements
            .filter(
              (e) =>
                e.getClientRects().length > 0 &&
                getComputedStyle(e).visibility !== "hidden",
            )
            .slice(0, 80)
            .map((element) => {
              const parts: string[] = [];
              let node: Element | null = element;
              for (
                let depth = 0;
                node && node.tagName !== "HTML" && depth < 10;
                depth++
              ) {
                if (node.id) {
                  parts.unshift(`#${CSS.escape(node.id)}`);
                  break;
                }
                const tag = node.tagName.toLowerCase(),
                  siblings = node.parentElement
                    ? [...node.parentElement.children].filter(
                        (e) => e.tagName === node?.tagName,
                      )
                    : [node];
                parts.unshift(
                  `${tag}:nth-of-type(${siblings.indexOf(node) + 1})`,
                );
                node = node.parentElement;
              }
              const tag = element.tagName.toLowerCase(),
                field = ["input", "textarea", "select"].includes(tag),
                url =
                  tag === "a"
                    ? new URL(
                        (element as HTMLAnchorElement).href,
                        location.href,
                      )
                    : undefined;
              return {
                selector: parts.join(" > "),
                role: (element.getAttribute("role") ?? tag).slice(0, 40),
                label: (
                  element.getAttribute("aria-label") ??
                  (field
                    ? (element as HTMLInputElement).labels?.[0]?.innerText
                    : (element as HTMLElement).innerText) ??
                  element.getAttribute("placeholder") ??
                  ""
                )
                  .trim()
                  .slice(0, 120),
                ...(tag === "input"
                  ? { type: (element as HTMLInputElement).type.slice(0, 40) }
                  : {}),
                ...(url && ["http:", "https:"].includes(url.protocol)
                  ? { href: `${url.origin}${url.pathname}` }
                  : {}),
              };
            })
            .filter((item) => item.selector.length <= 500),
        );
      return {
        status: "completed",
        page: this.pageStatus(tab),
        blockedOrigins: [...this.blockedOrigins],
        controls: controls.map((control) => ({
          ...control,
          selector: this.clean(control.selector),
          label: this.clean(control.label),
          ...(control.href ? { href: this.clean(control.href) } : {}),
        })),
        text: this.clean(
          await tab.page
            .locator("body")
            .evaluate(
              (body, limit) => (body as HTMLElement).innerText.slice(0, limit),
              browserLimits.resultChars + browserLimits.inputChars,
            ),
        ).slice(0, browserLimits.resultChars),
      };
    }
    if (action.action === "screenshot") {
      const id = randomUUID();
      const data = await tab.page.screenshot({
        type: "jpeg",
        quality: 65,
        mask: tab.page
          .frames()
          .flatMap((frame) => [
            frame.locator('input,textarea,[contenteditable="true"]'),
            ...[...this.secrets].map((value) =>
              frame.getByText(value, { exact: false }),
            ),
          ]),
      });
      requireThat(
        data.length <= browserLimits.downloadBytes,
        "browser_capacity",
        409,
      );
      await writeFile(join(this.options.home, "artifacts", id), data, {
        mode: 0o600,
      });
      await this.saveArtifact({
        id,
        name: "browser.jpg",
        mimeType: "image/jpeg",
        size: data.length,
        origin: this.allowed(tab),
        at: Date.now(),
      });
      return { status: "completed", reference: id, page: this.pageStatus(tab) };
    }
    if (action.action === "request_input") {
      const field = tab.page.locator(action.selector);
      requireThat(
        (await field.count()) === 1 &&
          (await field.isVisible()) &&
          (await field.isEditable()),
        "browser_field_unavailable",
        409,
      );
      const element = await field.elementHandle();
      requireThat(element, "browser_field_unavailable", 409);
      const origin = this.allowed(tab);
      if (
        new URL((await element.ownerFrame())?.url() ?? "about:blank").origin !==
        origin
      ) {
        await element.dispose();
        throw new Fault("browser_field_unavailable", 409);
      }
      this.clearInput();
      this.input = {
        pageId: tab.id,
        revision: tab.revision,
        origin,
        selector: action.selector,
        field: element,
        identity: await element.evaluate(fieldIdentity),
        expiresAt: Date.now() + browserLimits.requestMs,
      };
      return { status: "completed", page: this.pageStatus(tab) };
    }
    if (action.action === "fill") {
      const field = tab.page.locator(action.selector);
      const sensitive = await field.evaluate(
        (element) =>
          element instanceof HTMLInputElement &&
          (element.type === "password" ||
            /password|secret|token|otp|one.time|card|verification/i.test(
              `${element.name} ${element.id} ${element.autocomplete}`,
            )),
      );
      requireThat(!sensitive, "browser_sensitive_field", 403);
      await field.fill(action.text);
    }
    if (action.action === "click")
      await tab.page.locator(action.selector).click();
    if (action.action === "pointer")
      await tab.page.mouse.click(action.x, action.y);
    if (action.action === "press") await tab.page.keyboard.press(action.key);
    if (action.action === "scroll")
      await tab.page.mouse.wheel(action.x, action.y);
    return { status: "completed", page: this.pageStatus(tab) };
  }
  async close() {
    this.clearInput();
    await this.context?.close();
    this.context = undefined;
    this.secrets.clear();
  }
  async checkpoint(): Promise<BrowserCheckpoint> {
    requireThat(this.context, "browser_service_unavailable", 503);
    return browserCheckpoint.parse({
      cookies: (await this.context.cookies()).filter(
        (cookie) => cookie.expires === -1,
      ),
    });
  }
}
