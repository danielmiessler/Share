import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE58, ConfigError, cleanFilename, d1, loadConfig, newSlug, parseArgs, parseDuration, parseEnvFile, type Config } from "../cli/share.ts";
import { SLUG_RE } from "../src/share.ts";

const CFG: Config = {
  SHARE_URL: "https://share.example.com",
  CLOUDFLARE_ACCOUNT_ID: "acct",
  SHARE_D1_DATABASE_ID: "db",
  SHARE_D1_TOKEN: "t0ken",
  SHARE_R2_BUCKET: "share-files",
  SHARE_R2_ACCESS_KEY_ID: "ak",
  SHARE_R2_SECRET_ACCESS_KEY: "sk",
};

function configFile(mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "share-test-"));
  const path = join(dir, "config.env");
  writeFileSync(path, Object.entries(CFG).map(([k, v]) => `${k}=${v}`).join("\n"));
  chmodSync(path, mode);
  return path;
}

describe("slug", () => {
  test("slug is 22 base58 characters the worker accepts", () => {
    for (let i = 0; i < 200; i++) {
      const s = newSlug();
      expect(s.length).toBe(22);
      expect(SLUG_RE.test(s)).toBe(true);
    }
  });
  test("slug rejection-samples: bytes 232–255 are never used", () => {
    // A source that only ever returns 255 then 0 must still yield only "1"s, never a biased character.
    let flip = false;
    const s = newSlug(8, (b) => b.map(() => ((flip = !flip) ? 255 : 0)));
    expect(s).toBe("11111111");
  });
  test("slug alphabet has 58 distinct characters, none of 0 O I l", () => {
    expect(new Set(BASE58).size).toBe(58);
    expect(/[0OIl]/.test(BASE58)).toBe(false);
  });
});

describe("config", () => {
  test("permissions: a group- or world-readable config file is refused", () => {
    expect(() => loadConfig(configFile(0o644), {})).toThrow(ConfigError);
    expect(() => loadConfig(configFile(0o640), {})).toThrow(/chmod 600/);
  });
  test("permissions: a symlinked config file is refused", () => {
    const real = configFile(0o600);
    const link = real + ".link";
    symlinkSync(real, link);
    expect(() => loadConfig(link, {})).toThrow();
  });
  test("permissions: the file is not opened when the environment supplies every key", () => {
    expect(loadConfig(configFile(0o644), { ...CFG }).SHARE_D1_TOKEN).toBe("t0ken");
  });
  test("a 0600 config file loads", () => {
    expect(loadConfig(configFile(0o600), {}).SHARE_D1_TOKEN).toBe("t0ken");
  });
  test("missing keys are named", () => {
    expect(() => loadConfig("/nonexistent/config.env", { SHARE_URL: "https://x.example" })).toThrow(/SHARE_D1_TOKEN/);
  });
  test("SHARE_URL must be https", () => {
    expect(() => loadConfig("/nonexistent", { ...CFG, SHARE_URL: "http://share.example.com" })).toThrow(/https/);
  });
  test("env file parsing strips quotes, export and comments", () => {
    expect(parseEnvFile(`# c\nexport A="1"\nB='2'\nC=3 \n\nbad line`)).toEqual({ A: "1", B: "2", C: "3" });
  });
});

describe("d1", () => {
  test("parameterized: values travel in params, never in the SQL", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = async (url: string, init?: RequestInit) => {
      seen = { url, init: init! };
      return Response.json({ success: true, result: [{ success: true, results: [{ n: 1 }] }] });
    };
    const hostile = "x'); DROP TABLE shares; --";
    const rows = await d1(CFG, "SELECT * FROM shares WHERE slug = ?", [hostile], fake);
    expect(rows).toEqual([{ n: 1 }]);
    const body = JSON.parse(String(seen!.init.body));
    expect(body.sql).toBe("SELECT * FROM shares WHERE slug = ?");
    expect(body.params).toEqual([hostile]);
    expect(seen!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db/query");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer t0ken");
    expect(seen!.url).not.toContain("t0ken");
  });
  test("API errors surface", async () => {
    const fake = async () => Response.json({ success: false, errors: [{ message: "Authentication error" }] }, { status: 403 });
    await expect(d1(CFG, "SELECT 1", [], fake)).rejects.toThrow(/Authentication error/);
  });
});

describe("parsing", () => {
  test("expiry durations", () => {
    expect(parseDuration("30m")).toBe(1_800_000);
    expect(parseDuration("7d")).toBe(604_800_000);
    expect(() => parseDuration("7y")).toThrow();
    expect(() => parseDuration("400d")).toThrow();
    expect(() => parseDuration("0d")).toThrow();
  });
  test("filenames lose paths and control characters", () => {
    expect(cleanFilename("/tmp/a/b/report.pdf")).toBe("report.pdf");
    expect(cleanFilename("..\\..\\evil.txt")).toBe("evil.txt");
    expect(cleanFilename("bad\nname\t.txt")).toBe("bad_name_.txt");
    expect(() => cleanFilename("..")).toThrow();
    // truncation never splits a surrogate pair, so the download header can always encode it
    const long = cleanFilename("a".repeat(199) + "😀.txt");
    expect(long).toBe("a".repeat(199) + "😀");
    expect(() => encodeURIComponent(long)).not.toThrow();
  });
  test("argv", () => {
    expect(parseArgs(["demo.mp4", "--expires", "7d"])).toMatchObject({ command: "upload", target: "demo.mp4", expires: "7d" });
    expect(parseArgs(["rm", "abc"])).toMatchObject({ command: "rm", target: "abc" });
    expect(parseArgs(["list", "--json"])).toMatchObject({ command: "list", json: true });
    expect(parseArgs([]).command).toBe("help");
    expect(() => parseArgs(["--bogus"])).toThrow();
  });
});
