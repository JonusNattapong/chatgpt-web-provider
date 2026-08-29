import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  browserLoginStateExists,
  chatGptOnlyStorageState,
  loginToChatGpt,
  loginVerificationMarkerPath,
  resolveChromeProfileDirectory,
  stageChromeProfileForImport,
} from "../src/browser-login";
import { CHATGPT_TEMPORARY_CHAT_URL } from "../src/chatgpt-session";
import { defaultConfig } from "../src/config";

test("login starts with normal Chrome and captures state in a headed Keychain-aware context", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-"));
  const executable = join(root, "fake-chrome");
  const argsLog = join(root, "args.log");
  writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CODEX_LOGIN_ARG_LOG\"\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  const previousLog = process.env.CODEX_LOGIN_ARG_LOG;
  process.env.CODEX_LOGIN_ARG_LOG = argsLog;
  try {
    const config = defaultConfig("browser-only");
    config.chromeExecutablePath = executable;
    config.storageStatePath = join(root, "browser", "storage-state.json");
    await loginToChatGpt(config, { timeoutMs: 100 }).catch(() => {});

    const launches = readFileSync(argsLog, "utf8").trim().split("\n");
    const firstLaunch = launches[0] ?? "";
    expect(firstLaunch).toContain("--new-window");
    expect(firstLaunch).toContain("--user-data-dir=");
    expect(firstLaunch).toContain(CHATGPT_TEMPORARY_CHAT_URL);
    expect(firstLaunch).not.toContain("--remote-debugging-pipe");
    expect(launches[1]).not.toContain("--headless");
  } finally {
    if (previousLog === undefined) delete process.env.CODEX_LOGIN_ARG_LOG;
    else process.env.CODEX_LOGIN_ARG_LOG = previousLog;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a storage-state file is not trusted without a verification marker", () => {
  const root = mkdtempSync(join(tmpdir(), "codex-chatgpt-web-login-state-"));
  try {
    const config = defaultConfig("browser-only");
    config.storageStatePath = join(root, "storage-state.json");
    writeFileSync(config.storageStatePath, "{}\n", { mode: 0o600 });
    expect(browserLoginStateExists(config)).toBe(false);

    writeFileSync(
      loginVerificationMarkerPath(config.storageStatePath),
      `${JSON.stringify({ version: 1, authenticated: true, verifiedAt: "2026-07-26T00:00:00.000Z" })}\n`,
      { mode: 0o600 },
    );
    expect(browserLoginStateExists(config)).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Chrome profile import rejects path traversal", () => {
  const root = join(tmpdir(), "chrome-user-data");
  expect(resolveChromeProfileDirectory(root, "Default")).toBe(join(root, "Default"));
  expect(() => resolveChromeProfileDirectory(root, "..\\Other")).toThrow("Chrome profile must be a directory name");
  expect(() => resolveChromeProfileDirectory(root, "../Other")).toThrow("Chrome profile must be a directory name");
});

test("Chrome profile import keeps only ChatGPT and OpenAI browser state", () => {
  const filtered = chatGptOnlyStorageState({
    cookies: [
      { name: "chat", value: "secret", domain: ".chatgpt.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
      { name: "auth", value: "secret", domain: "auth.openai.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
      { name: "unrelated", value: "secret", domain: ".example.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
    ],
    origins: [
      { origin: "https://chatgpt.com", localStorage: [{ name: "setting", value: "value" }] },
      { origin: "https://example.com", localStorage: [{ name: "private", value: "value" }] },
    ],
  });
  expect(filtered.cookies.map(cookie => cookie.domain)).toEqual([".chatgpt.com", "auth.openai.com"]);
  expect(filtered.origins.map(origin => origin.origin)).toEqual(["https://chatgpt.com"]);
});

test("Chrome profile import stages only bounded session prerequisites", () => {
  const root = mkdtempSync(join(tmpdir(), "chrome-profile-source-"));
  const staged = mkdtempSync(join(tmpdir(), "chrome-profile-staged-"));
  try {
    writeFileSync(join(root, "Local State"), "{}\n");
    mkdirSync(join(root, "Default", "Network"), { recursive: true });
    writeFileSync(join(root, "Default", "Preferences"), "{}\n");
    writeFileSync(join(root, "Default", "Network", "Cookies"), "cookie-db");
    writeFileSync(join(root, "Default", "History"), "history-db");

    stageChromeProfileForImport(root, "Default", staged);

    expect(readFileSync(join(staged, "Local State"), "utf8")).toBe("{}\n");
    expect(readFileSync(join(staged, "Default", "Network", "Cookies"), "utf8")).toBe("cookie-db");
    expect(existsSync(join(staged, "Default", "History"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  }
});
