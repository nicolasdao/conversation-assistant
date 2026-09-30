// Static contracts of the Mac app's package (electron-builder.yml, desktop/*.plist, the helpers' Info.plist) and the
// identifiers that must never change (docs/desktop.md § The name, and what kept the old one; docs/gotchas.md § Mac app).
// The files are read as text and parsed with regexes: the project has no YAML or plist parser, on purpose.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");
const builder = read("electron-builder.yml");
const mainTs = read("desktop/main.ts");

/** A top-level YAML key's block: the indented lines after `key:` up to the next top-level key. */
function block(yaml: string, key: string): string {
  const m = new RegExp(`^${key}:[^\\n]*\\n((?:(?:[ \\t]+[^\\n]*|[ \\t]*#[^\\n]*|)\\n)*)`, "m").exec(yaml);
  if (!m) throw new Error(`no ${key}: block`);
  return m[1]!;
}
/** A scalar `key: value` (the first one, at any indent), without its trailing comment and quotes. */
function scalar(yaml: string, key: string): string {
  const m = new RegExp(`^[ \\t]*${key}:[ \\t]*(.+?)[ \\t]*(?:#.*)?$`, "m").exec(yaml);
  if (!m) throw new Error(`no ${key}`);
  return m[1]!.replace(/^"(.*)"$/, "$1");
}
/** A YAML block's list items (`- value`), without quotes and comments. */
const items = (text: string) => [...text.matchAll(/^[ \t]*-[ \t]+(.+?)[ \t]*(?:#.*)?$/gm)].map((m) => m[1]!.replace(/^"(.*)"$/, "$1"));

/** A plist's boolean keys (comments removed), in order. */
function plistBools(xml: string): Record<string, boolean> {
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
  return Object.fromEntries([...body.matchAll(/<key>([^<]+)<\/key>\s*<(true|false)\/>/g)].map((m) => [m[1]!, m[2] === "true"]));
}
/** A plist's string value for a key. */
function plistString(xml: string, key: string): string {
  const m = new RegExp(`<key>${key.replace(/\./g, "\\.")}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  if (!m) throw new Error(`no ${key}`);
  return m[1]!;
}

describe("identifiers that keep the name from before the rename (never change them)", () => {
  it("the bundle id is com.cloudlesslabs.conversation-assistant: the permissions and updates are tied to it", () => {
    expect(scalar(builder, "appId")).toBe("com.cloudlesslabs.conversation-assistant");
  });

  it("the page's address is app://conversation-assistant: the window's storage is kept per address", () => {
    expect(mainTs).toMatch(/^const ORIGIN = "app:\/\/conversation-assistant";$/m);
    // the scheme handler answers that host only, and the scheme is `app`
    expect(mainTs).toContain('new URL(req.url).host !== "conversation-assistant"');
    expect(mainTs).toContain('protocol.handle("app",');
  });

  it("the notary keychain profile is conversation-assistant, in the build script and the release skill", () => {
    const build = read("scripts/build-mac.sh");
    expect(build).toContain("--keychain-profile conversation-assistant");
    expect(build).toContain("APPLE_KEYCHAIN_PROFILE=conversation-assistant");
    expect(read(".agents/skills/release-tattle/scripts/build-app.sh")).toContain("APPLE_KEYCHAIN_PROFILE=conversation-assistant");
    expect(read(".agents/skills/release-tattle/scripts/credentials.sh")).toContain("--keychain-profile conversation-assistant");
    // no other profile name anywhere they set one
    for (const text of [build, read(".agents/skills/release-tattle/scripts/build-app.sh"), read(".agents/skills/release-tattle/scripts/credentials.sh")]) {
      for (const m of text.matchAll(/(?:--keychain-profile|APPLE_KEYCHAIN_PROFILE=)[ \t]*([A-Za-z0-9._-]+)/g)) expect(m[1]).toBe("conversation-assistant");
    }
  });

  it("the capture helper's bundle id is com.cloudlesslabs.conversation-capture", () => {
    expect(plistString(read("native/capture/Info.plist"), "CFBundleIdentifier")).toBe("com.cloudlesslabs.conversation-capture");
  });

  it("the name people see is Tattle", () => {
    expect(scalar(builder, "productName")).toBe("Tattle");
    expect(scalar(block(builder, "dmg"), "title")).toBe("Tattle");
    expect(mainTs).toContain('title: "Tattle"');
  });
});

describe("electron-builder.yml", () => {
  it("sets every hardening fuse: no running as Node, no NODE_OPTIONS, no --inspect; the asar checked and the only code", () => {
    const fuses = block(builder, "electronFuses");
    expect(Object.fromEntries([...fuses.matchAll(/^[ \t]+(\w+):[ \t]*(true|false)/gm)].map((m) => [m[1], m[2] === "true"]))).toEqual({
      runAsNode: false,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    });
  });

  it("ships only dist/desktop, package.json and LICENSE as the app's code, never a source map", () => {
    expect(items(block(builder, "files"))).toEqual(["dist/desktop/**", "package.json", "LICENSE", "!**/*.map"]);
  });

  it("the bundle and preload the app loads are the ones built into dist/desktop", () => {
    const pkg = JSON.parse(read("package.json")) as { main: string; scripts: Record<string, string> };
    expect(pkg.main).toBe("dist/desktop/main.mjs");
    expect(pkg.scripts["build:desktop"]).toContain("--outfile=dist/desktop/main.mjs");
    expect(pkg.scripts["build:desktop"]).toMatch(/desktop\/preload\.ts[^&]*--format=cjs[^&]*--outfile=dist\/desktop\/preload\.cjs/);
    expect(mainTs).toContain('preload: join(import.meta.dirname, "preload.cjs")');
  });

  it("publishes to GitHub nicolasdao/tattle, the repository desktop/main.ts links to", () => {
    const publish = block(builder, "publish");
    expect(scalar(publish, "provider")).toBe("github");
    expect(scalar(publish, "releaseType")).toBe("release");
    const repo = `https://github.com/${scalar(publish, "owner")}/${scalar(publish, "repo")}`;
    expect(repo).toBe("https://github.com/nicolasdao/tattle");
    expect(mainTs).toContain(`const REPO = "${repo}";`);
  });

  it("signs with entitlements.mac.plist, for the app and everything in it, under the hardened runtime, notarized", () => {
    const mac = block(builder, "mac");
    expect(scalar(mac, "entitlements")).toBe("desktop/entitlements.mac.plist");
    expect(scalar(mac, "entitlementsInherit")).toBe("desktop/entitlements.mac.plist");
    expect(scalar(mac, "hardenedRuntime")).toBe("true");
    expect(scalar(mac, "notarize")).toBe("true");
    expect(builder).not.toContain("entitlements.adhoc.plist");
  });

  it("only the ad-hoc build uses entitlements.adhoc.plist, never a Developer ID one or the release", () => {
    const build = read("scripts/build-mac.sh");
    const adhoc = build.indexOf("signing ad hoc");
    expect(adhoc).toBeGreaterThan(0);
    expect(build.slice(0, adhoc)).not.toContain("entitlements.adhoc.plist");
    expect(build.slice(adhoc)).toMatch(/-c\.mac\.identity=- [^\n]*\\\n[^\n]*-c\.mac\.entitlements=desktop\/entitlements\.adhoc\.plist/);
    expect(read(".agents/skills/release-tattle/scripts/build-app.sh")).not.toContain("adhoc");
  });

  it("targets Apple Silicon only, as a DMG and a zip (what updates download), on macOS 14.2 or later", () => {
    const mac = block(builder, "mac");
    const targets = [...block(mac.replace(/^ {2}/gm, ""), "target").matchAll(/target:[ \t]*(\w+)[^\n]*\n[ \t]+arch:[ \t]*(\w+)/g)].map((m) => `${m[1]}/${m[2]}`);
    expect(targets).toEqual(["dmg/arm64", "zip/arm64"]);
    expect(scalar(mac, "minimumSystemVersion")).toBe("14.2"); // the Core Audio process tap
  });

  it("keeps English only, and unpacks sherpa-onnx's addon from the archive", () => {
    expect(scalar(builder, "electronLanguages")).toBe("[en]");
    expect(items(block(builder, "asarUnpack"))).toEqual(["node_modules/sherpa-onnx-*/**"]);
  });

  it("puts in Resources every path the packaged app reads (desktop/main.ts)", () => {
    const to = [...block(builder, "extraResources").matchAll(/^[ \t]+to:[ \t]*(\S+)/gm)].map((m) => m[1]!);
    for (const path of ["web", "config", "models", "bin/tattle-capture", "bin/tattle-transcribe", "licenses",
      "licenses/THIRD_PARTY_NOTICES.txt", "licenses/LICENSES.chromium.html", "licenses/LICENSE.txt"]) {
      expect(to, path).toContain(path);
    }
    // and main.ts reads them from there
    for (const p of ['join(res, "web")', 'join(res, "config")', 'join(res, "models")', 'join(res, "bin", "tattle-capture")',
      'join(res, "bin", "tattle-transcribe")', 'join(res, "licenses", "THIRD_PARTY_NOTICES.txt")', 'join(res, "licenses")',
      'join(licensesDir(), "LICENSES.chromium.html")']) {
      expect(mainTs, p).toContain(p);
    }
  });

  it("the usage strings macOS shows are the capture and transcription helpers' own", () => {
    const extend = block(block(builder, "mac").replace(/^ {2}/gm, ""), "extendInfo");
    const capture = read("native/capture/Info.plist");
    const transcribe = read("native/transcribe/Info.plist");
    expect(scalar(extend, "NSMicrophoneUsageDescription")).toBe(plistString(capture, "NSMicrophoneUsageDescription"));
    expect(scalar(extend, "NSAudioCaptureUsageDescription")).toBe(plistString(capture, "NSAudioCaptureUsageDescription"));
    expect(scalar(extend, "NSSpeechRecognitionUsageDescription")).toBe(plistString(transcribe, "NSSpeechRecognitionUsageDescription"));
    for (const k of ["NSMicrophoneUsageDescription", "NSAudioCaptureUsageDescription", "NSSpeechRecognitionUsageDescription"]) {
      expect(scalar(extend, k), k).toMatch(/^Tattle /);
    }
  });
});

describe("entitlements", () => {
  const mac = plistBools(read("desktop/entitlements.mac.plist"));
  const adhoc = plistBools(read("desktop/entitlements.adhoc.plist"));

  it("the release's are exactly V8's JIT and the microphone", () => {
    expect(mac).toEqual({
      "com.apple.security.cs.allow-jit": true,
      "com.apple.security.cs.allow-unsigned-executable-memory": true,
      "com.apple.security.device.audio-input": true,
    });
  });

  it("the ad-hoc build's are the release's plus disable-library-validation, and nothing else", () => {
    expect(adhoc).toEqual({ ...mac, "com.apple.security.cs.disable-library-validation": true });
  });

  it("the release's never disable library validation", () => {
    expect(read("desktop/entitlements.mac.plist").replace(/<!--[\s\S]*?-->/g, "")).not.toContain("disable-library-validation");
  });
});
