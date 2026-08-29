import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir, platform } from "node:os";
import { chromium, type BrowserContextOptions } from "playwright-core";
import type { AppConfig } from "./config";
import { atomicWriteFile } from "./config";
import {
  assertAuthenticatedChatGptPage,
  assertTemporaryChatPage,
  CHATGPT_TEMPORARY_CHAT_URL,
  detectChatGptAccountCapabilities,
} from "./chatgpt-session";
import type { ChatGptWebAccountCapabilities } from "./chatgpt-web-models";

export interface BrowserLoginResult {
  storageStatePath: string;
  accountSurfaceUrl: string;
  solAvailable: boolean;
  proAvailable: boolean;
}

interface LoginVerificationMarker {
  version: 1;
  authenticated: true;
  verifiedAt: string;
  solAvailable?: boolean;
  proAvailable?: boolean;
}

export interface ChromeProfileImportOptions {
  profileDirectory?: string;
  userDataDir?: string;
  timeoutMs?: number;
}

type BrowserStorageState = Exclude<NonNullable<BrowserContextOptions["storageState"]>, string>;

const CHATGPT_STORAGE_DOMAINS = ["chatgpt.com", "openai.com"] as const;

export function defaultChromeUserDataDir(): string {
  if (platform() === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    if (!localAppData) throw new Error("LOCALAPPDATA is unavailable; cannot locate the Chrome profile");
    return join(localAppData, "Google", "Chrome", "User Data");
  }
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Google", "Chrome");
  return join(homedir(), ".config", "google-chrome");
}

export function resolveChromeProfileDirectory(userDataDir: string, profileDirectory: string): string {
  const name = profileDirectory.trim();
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error("Chrome profile must be a directory name such as Default or Profile 1");
  }
  const root = resolve(userDataDir);
  const profile = resolve(root, name);
  if (!profile.startsWith(`${root}${sep}`)) throw new Error("Chrome profile resolves outside the Chrome user-data directory");
  return profile;
}

export function stageChromeProfileForImport(
  userDataDir: string,
  profileDirectory: string,
  destinationRoot: string,
): void {
  const sourceProfile = resolveChromeProfileDirectory(userDataDir, profileDirectory);
  const sourceLocalState = join(resolve(userDataDir), "Local State");
  if (!existsSync(sourceLocalState)) throw new Error(`Chrome Local State does not exist: ${sourceLocalState}`);

  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  copyFileSync(sourceLocalState, join(destinationRoot, "Local State"));
  const relativeFiles = [
    "Preferences",
    "Secure Preferences",
    join("Network", "Cookies"),
    join("Network", "Cookies-journal"),
  ];
  for (const relativeFile of relativeFiles) {
    const source = join(sourceProfile, relativeFile);
    if (!existsSync(source)) continue;
    const destination = join(destinationRoot, profileDirectory, relativeFile);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(source, destination);
  }
}

export function chatGptOnlyStorageState(
  storageState: BrowserStorageState,
): BrowserStorageState {
  const domainAllowed = (domain: string): boolean => {
    const normalized = domain.replace(/^\./, "").toLowerCase();
    return CHATGPT_STORAGE_DOMAINS.some(allowed => normalized === allowed || normalized.endsWith(`.${allowed}`));
  };
  return {
    cookies: storageState.cookies.filter(cookie => domainAllowed(cookie.domain)),
    origins: storageState.origins.filter(origin => {
      try {
        return domainAllowed(new URL(origin.origin).hostname);
      } catch {
        return false;
      }
    }),
  };
}

export function loginVerificationMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

function writeVerificationMarker(
  storageStatePath: string,
  capabilities: ChatGptWebAccountCapabilities,
): void {
  const marker: LoginVerificationMarker = {
    version: 1,
    authenticated: true,
    verifiedAt: new Date().toISOString(),
    ...capabilities,
  };
  atomicWriteFile(loginVerificationMarkerPath(storageStatePath), `${JSON.stringify(marker)}\n`);
}

async function inspectStoredState(
  config: AppConfig,
  storageState: NonNullable<BrowserContextOptions["storageState"]>,
): Promise<ChatGptWebAccountCapabilities & { url: string }> {
  const verifierBrowser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const verifierContext = await verifierBrowser.newContext({ storageState });
    try {
      const verifierPage = await verifierContext.newPage();
      await verifierPage.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await verifierPage.getByRole("textbox", { name: "Chat with ChatGPT" }).waitFor({ state: "visible", timeout: 60_000 });
      await assertAuthenticatedChatGptPage(verifierPage);
      await assertTemporaryChatPage(verifierPage);
      return { ...await detectChatGptAccountCapabilities(verifierPage), url: verifierPage.url() };
    } finally {
      await verifierContext.close();
    }
  } finally {
    await verifierBrowser.close();
  }
}

export async function inspectBrowserLoginCapabilities(config: AppConfig): Promise<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) throw new Error("ChatGPT login state is missing or unverified");
  const inspected = await inspectStoredState(config, config.storageStatePath);
  writeVerificationMarker(config.storageStatePath, inspected);
  return { solAvailable: inspected.solAvailable, proAvailable: inspected.proAvailable };
}

export function storedBrowserLoginCapabilities(
  config: AppConfig,
): Partial<ChatGptWebAccountCapabilities> {
  if (!browserLoginStateExists(config)) return {};
  try {
    const marker = JSON.parse(readFileSync(loginVerificationMarkerPath(config.storageStatePath), "utf8")) as Partial<LoginVerificationMarker>;
    return {
      ...(typeof marker.solAvailable === "boolean" ? { solAvailable: marker.solAvailable } : {}),
      ...(typeof marker.proAvailable === "boolean" ? { proAvailable: marker.proAvailable } : {}),
    };
  } catch {
    return {};
  }
}

export async function loginToChatGpt(
  config: AppConfig,
  options: { timeoutMs?: number } = {},
): Promise<BrowserLoginResult> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}. Pass --chrome with its executable path.`);
  }
  const profileDir = join(dirname(config.storageStatePath), "login-profile");
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  process.stdout.write(
    "A normal Chrome window is open. Sign in to ChatGPT, confirm that the composer is visible, then quit this dedicated Chrome instance completely.\n",
  );
  const loginBrowser = spawn(config.chromeExecutablePath, [
    `--user-data-dir=${profileDir}`,
    "--new-window",
    "--disable-background-mode",
    "--no-first-run",
    "--no-default-browser-check",
    CHATGPT_TEMPORARY_CHAT_URL,
  ], { env: process.env, stdio: "ignore" });
  const loginExit = await new Promise<number>((resolveExit, rejectExit) => {
    loginBrowser.once("error", rejectExit);
    loginBrowser.once("exit", (code, signal) => {
      if (signal) rejectExit(new Error(`Normal Chrome login window exited from signal ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (loginExit !== 0) throw new Error(`Normal Chrome login window exited with status ${loginExit}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: config.chromeExecutablePath,
    headless: false,
    ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(CHATGPT_TEMPORARY_CHAT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" }).or(
      page.locator('[data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"]'),
    ).first();
    try {
      await composer.waitFor({ state: "visible", timeout: options.timeoutMs ?? 60_000 });
    } catch {
      throw new Error("The authenticated ChatGPT page did not produce a visible composer");
    }
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);
    const state = await context.storageState();

    const inspected = await inspectStoredState(config, state);
    atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
    writeVerificationMarker(config.storageStatePath, inspected);
    return {
      storageStatePath: config.storageStatePath,
      accountSurfaceUrl: page.url(),
      solAvailable: inspected.solAvailable,
      proAvailable: inspected.proAvailable,
    };
  } finally {
    await context.close();
    if (browserLoginStateExists(config)) rmSync(profileDir, { recursive: true, force: true });
  }
}

export async function importChromeProfileToChatGpt(
  config: AppConfig,
  options: ChromeProfileImportOptions = {},
): Promise<BrowserLoginResult> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
  }
  const userDataDir = resolve(options.userDataDir ?? defaultChromeUserDataDir());
  const profileDirectory = options.profileDirectory?.trim() || "Default";
  const profilePath = resolveChromeProfileDirectory(userDataDir, profileDirectory);
  if (!existsSync(profilePath)) throw new Error(`Chrome profile does not exist: ${profilePath}`);

  mkdirSync(dirname(config.storageStatePath), { recursive: true, mode: 0o700 });
  const stagedUserDataDir = mkdtempSync(join(dirname(config.storageStatePath), "profile-import-"));
  try {
    stageChromeProfileForImport(userDataDir, profileDirectory, stagedUserDataDir);
  } catch (error) {
    rmSync(stagedUserDataDir, { recursive: true, force: true });
    throw error;
  }

  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>;
  try {
    context = await chromium.launchPersistentContext(stagedUserDataDir, {
      executablePath: config.chromeExecutablePath,
      headless: false,
      ignoreDefaultArgs: ["--password-store=basic", "--use-mock-keychain"],
      args: [
        `--profile-directory=${profileDirectory}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
      ],
    });
  } catch (error) {
    rmSync(stagedUserDataDir, { recursive: true, force: true });
    throw new Error(
      `Could not open Chrome profile ${profileDirectory}. Close every Chrome window and background process, then retry.`,
      { cause: error },
    );
  }

  try {
    const page = await context.newPage();
    await page.goto(CHATGPT_TEMPORARY_CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const composer = page.getByRole("textbox", { name: "Chat with ChatGPT" }).or(
      page.locator('[data-testid="prompt-textarea"], [contenteditable="true"][data-lexical-editor="true"]'),
    ).first();
    await composer.waitFor({ state: "visible", timeout: options.timeoutMs ?? 60_000 });
    await assertAuthenticatedChatGptPage(page);
    await assertTemporaryChatPage(page);

    const state = chatGptOnlyStorageState(await context.storageState());
    const inspected = await inspectStoredState(config, state);
    atomicWriteFile(config.storageStatePath, `${JSON.stringify(state)}\n`);
    writeVerificationMarker(config.storageStatePath, inspected);
    return {
      storageStatePath: config.storageStatePath,
      accountSurfaceUrl: page.url(),
      solAvailable: inspected.solAvailable,
      proAvailable: inspected.proAvailable,
    };
  } catch (error) {
    throw new Error(`Chrome profile ${profileDirectory} does not contain a usable ChatGPT login`, { cause: error });
  } finally {
    await context.close();
    rmSync(stagedUserDataDir, { recursive: true, force: true });
  }
}

export function browserLoginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)) return false;
  const markerPath = loginVerificationMarkerPath(config.storageStatePath);
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<LoginVerificationMarker>;
    return marker.version === 1 && marker.authenticated === true && typeof marker.verifiedAt === "string";
  } catch {
    return false;
  }
}

export async function checkBrowserEngine(config: AppConfig): Promise<void> {
  if (!existsSync(config.chromeExecutablePath)) throw new Error(`Google Chrome was not found at ${config.chromeExecutablePath}`);
  const browser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: true,
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  try {
    const page = await browser.newPage();
    await page.goto("about:blank");
    if (await page.evaluate(() => document.readyState) !== "complete") throw new Error("Browser page did not reach complete state");
  } finally {
    await browser.close();
  }
}
