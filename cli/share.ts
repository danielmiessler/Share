#!/usr/bin/env bun
/**
 * share — the only writer.
 *
 *   share <file> [--expires 7d] [--name <shown name>] [--json] [--no-copy]
 *   share list [--limit 50] [--json]
 *   share rm <slug>
 *   share prune                remove every expired share (row and file)
 *   share doctor               check config, credentials and the live Worker
 *
 * It holds two narrow credentials: a Cloudflare API token that can edit D1 and
 * nothing else, and an R2 token that can read and write one bucket. The public
 * Worker holds no credential at all. See README § Security model.
 */

import { basename } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

export const CONFIG_KEYS = [
  "SHARE_URL",
  "CLOUDFLARE_ACCOUNT_ID",
  "SHARE_D1_DATABASE_ID",
  "SHARE_D1_TOKEN",
  "SHARE_R2_BUCKET",
  "SHARE_R2_ACCESS_KEY_ID",
  "SHARE_R2_SECRET_ACCESS_KEY",
] as const;

export type Config = Record<(typeof CONFIG_KEYS)[number], string>;

export class ConfigError extends Error {}

export function defaultConfigPath(): string {
  return process.env.SHARE_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "share", "config.env");
}

/** KEY=value lines; blank lines and # comments ignored; one layer of matching quotes stripped. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2]!;
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/**
 * Read a credentials file only if it is a regular file, owned by this user, and not readable or
 * writable by anyone else. The checks run on the open descriptor, so the file cannot be swapped
 * between the check and the read; O_NONBLOCK keeps a FIFO from hanging the open. POSIX mode bits
 * only: ACLs are not inspected, and on Windows the file is read unchecked.
 */
export function readPrivateFile(path: string): string {
  if (process.platform === "win32") return readFileSync(path, "utf8");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ConfigError(`${path} is not a regular file`);
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new ConfigError(`${path} is owned by another user`);
    const mode = st.mode & 0o777;
    if (mode & 0o077) throw new ConfigError(`${path} is readable by other users (mode ${mode.toString(8)}). Run: chmod 600 "${path}"`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function loadConfig(path = defaultConfigPath(), env: Record<string, string | undefined> = process.env): Config {
  let file: Record<string, string> = {};
  // The file is only opened when the environment leaves something out.
  if (CONFIG_KEYS.some((k) => !env[k]) && existsSync(path)) file = parseEnvFile(readPrivateFile(path));
  const cfg = {} as Config;
  const missing: string[] = [];
  for (const key of CONFIG_KEYS) {
    const v = env[key] ?? file[key];
    if (!v) missing.push(key);
    else cfg[key] = v;
  }
  if (missing.length) throw new ConfigError(`missing ${missing.join(", ")} (config: ${path})`);
  const url = new URL(cfg.SHARE_URL);
  if (url.protocol !== "https:") throw new ConfigError("SHARE_URL must be https://");
  cfg.SHARE_URL = url.origin;
  return cfg;
}

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

export const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** 22 base58 characters from the CSPRNG, rejection-sampled so every character is uniform: ~128.9 bits. */
export function newSlug(length = 22, random: (buf: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  let out = "";
  while (out.length < length) {
    for (const byte of random(new Uint8Array(length * 2))) {
      if (byte < 232 && out.length < length) out += BASE58[byte % 58];
    }
  }
  return out;
}

/** "30m", "24h", "7d", "2w" → milliseconds. Capped at a year. */
export function parseDuration(input: string): number {
  const m = input.trim().match(/^(\d+)\s*([mhdw])$/i);
  if (!m) throw new Error(`cannot read duration "${input}" (use 30m, 24h, 7d or 2w)`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]!.toLowerCase() as "m" | "h" | "d" | "w"];
  const ms = Number(m[1]) * unit;
  if (ms <= 0 || ms > 365 * 86_400_000) throw new Error("duration must be between 1 minute and 365 days");
  return ms;
}

/** The name shown on the page and in downloads: no path, no control characters, at most 200 characters (code points, never half a pair). */
export function cleanFilename(name: string): string {
  const base = basename(name.replace(/\\/g, "/"));
  const cleaned = Array.from(base.replace(/[\x00-\x1f\x7f/]/g, "_").trim()).slice(0, 200).join("");
  if (!cleaned || cleaned === "." || cleaned === "..") throw new Error(`unusable file name "${name}"`);
  return cleaned;
}

/** The R2 key is the slug alone. The file name lives only in D1, so no character in it can change which object is read. */
export function objectKey(slug: string): string {
  return slug;
}

export interface Args {
  command: "upload" | "list" | "rm" | "prune" | "doctor" | "help";
  target?: string;
  expires?: string;
  name?: string;
  limit: number;
  json: boolean;
  copy: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { command: "help", limit: 50, json: false, copy: true };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${t} needs a value`);
      return v;
    };
    if (t === "--expires") a.expires = value();
    else if (t === "--name") a.name = value();
    else if (t === "--limit") a.limit = Math.max(1, Math.min(1000, Number(value()) || 50));
    else if (t === "--json") a.json = true;
    else if (t === "--no-copy") a.copy = false;
    else if (t === "-h" || t === "--help") return { ...a, command: "help" };
    else if (t.startsWith("--")) throw new Error(`unknown flag ${t}`);
    else rest.push(t);
  }
  const [first, second] = rest;
  if (first === undefined) return a;
  if (first === "list" || first === "prune" || first === "doctor") a.command = first;
  else if (first === "rm") {
    if (!second) throw new Error("usage: share rm <slug>");
    a.command = "rm";
    a.target = second;
  } else {
    a.command = "upload";
    a.target = first;
  }
  return a;
}

/* ------------------------------------------------------------------ *
 * D1 over the REST API — parameterized, always
 * ------------------------------------------------------------------ */

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function d1<T = Record<string, unknown>>(cfg: Config, sql: string, params: (string | number | null)[] = [], fetchImpl: Fetch = fetch): Promise<T[]> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.CLOUDFLARE_ACCOUNT_ID)}/d1/database/${encodeURIComponent(cfg.SHARE_D1_DATABASE_ID)}/query`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.SHARE_D1_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; errors?: { message: string }[]; result?: { success?: boolean; results?: T[] }[] }
    | null;
  if (!res.ok || !body?.success || body.result?.[0]?.success === false) {
    const why = body?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`D1 query failed: ${why}`);
  }
  return body.result?.[0]?.results ?? [];
}

/* ------------------------------------------------------------------ *
 * R2 through its bulk endpoint, with a bucket-scoped token
 * ------------------------------------------------------------------ */

export function bucket(cfg: Config) {
  return new Bun.S3Client({
    accessKeyId: cfg.SHARE_R2_ACCESS_KEY_ID,
    secretAccessKey: cfg.SHARE_R2_SECRET_ACCESS_KEY,
    bucket: cfg.SHARE_R2_BUCKET,
    endpoint: `https://${cfg.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  });
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

interface Row {
  slug: string;
  filename: string;
  size: number;
  mime: string;
  created_at: string;
  expires_at: string | null;
}

async function copyToClipboard(text: string): Promise<boolean> {
  const tools = process.platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"]];
  for (const cmd of tools) {
    if (!Bun.which(cmd[0]!)) continue;
    const p = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    p.stdin.write(text);
    p.stdin.end();
    if ((await p.exited) === 0) return true;
  }
  return false;
}

async function upload(cfg: Config, args: Args): Promise<void> {
  const path = args.target!;
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`no such file: ${path}`);
  const filename = cleanFilename(args.name ?? path);
  const mime = file.type || "application/octet-stream";
  const now = new Date();
  const expires = args.expires ? new Date(now.getTime() + parseDuration(args.expires)).toISOString() : null;
  const slug = newSlug();

  // Reserve the slug first: a collision fails here, before any object can be overwritten.
  await d1(cfg, "INSERT INTO shares (slug, filename, size, mime, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)", [
    slug, filename, file.size, mime, now.toISOString(), expires,
  ]);
  try {
    await bucket(cfg).write(objectKey(slug), file, { type: mime });
  } catch (err) {
    const why = (err as Error).message;
    try {
      // The bytes may have landed even though the reply was lost: remove both, object first.
      await bucket(cfg).delete(objectKey(slug));
      await d1(cfg, "DELETE FROM shares WHERE slug = ?", [slug]);
    } catch {
      throw new Error(`upload failed (${why}) and ${slug} could not be cleaned up; run: share rm ${slug}`);
    }
    throw new Error(`upload failed, the link was withdrawn: ${why}`);
  }

  const link = `${cfg.SHARE_URL}/${slug}`;
  if (args.json) return console.log(JSON.stringify({ link, slug, filename, size: file.size, mime, expires_at: expires }));
  const copied = args.copy && (await copyToClipboard(link));
  console.log(link + (copied ? "   (copied)" : ""));
}

async function list(cfg: Config, args: Args): Promise<void> {
  const rows = await d1<Row>(cfg, "SELECT slug, filename, size, mime, created_at, expires_at FROM shares ORDER BY created_at DESC LIMIT ?", [args.limit]);
  if (args.json) return console.log(JSON.stringify(rows.map((r) => ({ ...r, link: `${cfg.SHARE_URL}/${r.slug}` }))));
  if (!rows.length) return console.log("no shares yet");
  for (const r of rows) {
    const exp = r.expires_at ? `  expires ${r.expires_at.slice(0, 16).replace("T", " ")}` : "";
    console.log(`${r.created_at.slice(0, 16).replace("T", " ")}  ${cfg.SHARE_URL}/${r.slug}  ${r.filename}${exp}`);
  }
}

async function remove(cfg: Config, slug: string): Promise<void> {
  const [row] = await d1<Row>(cfg, "SELECT slug FROM shares WHERE slug = ?", [slug]);
  if (!row) throw new Error(`no share ${slug}`);
  // File first: once it is gone the link is dead. If that fails the row stays, so a retry still knows the key.
  await bucket(cfg).delete(objectKey(slug));
  await d1(cfg, "DELETE FROM shares WHERE slug = ?", [slug]);
}

async function prune(cfg: Config): Promise<void> {
  const rows = await d1<Row>(cfg, "SELECT slug, filename FROM shares WHERE expires_at IS NOT NULL AND expires_at <= ?", [new Date().toISOString()]);
  for (const r of rows) await remove(cfg, r.slug);
  console.log(`pruned ${rows.length} expired share${rows.length === 1 ? "" : "s"}`);
}

async function doctor(): Promise<void> {
  let failed = 0;
  const line = (ok: boolean, what: string, note = "") => {
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"}  ${what}${note ? `  (${note})` : ""}`);
  };
  let cfg: Config;
  try {
    cfg = loadConfig();
    line(true, `config ${defaultConfigPath()}`);
  } catch (err) {
    line(false, "config", (err as Error).message);
    process.exit(1);
  }
  try {
    const [r] = await d1<{ n: number }>(cfg, "SELECT COUNT(*) AS n FROM shares");
    line(true, "D1 token can query the shares table", `${r?.n ?? 0} rows`);
  } catch (err) {
    line(false, "D1 token", (err as Error).message);
  }
  try {
    await bucket(cfg).list({ maxKeys: 1 });
    line(true, `R2 token can reach bucket ${cfg.SHARE_R2_BUCKET}`);
  } catch (err) {
    line(false, "R2 token", (err as Error).message);
  }
  try {
    const robots = await fetch(`${cfg.SHARE_URL}/robots.txt`);
    line(robots.ok && (await robots.text()).includes("Disallow: /"), `Worker answers at ${cfg.SHARE_URL}`);
    const post = await fetch(`${cfg.SHARE_URL}/`, { method: "POST" });
    line(post.status === 405, "Worker refuses writes", `POST → ${post.status}`);
    const probe = await fetch(`${cfg.SHARE_URL}/${newSlug()}`);
    line(probe.status === 404 && (probe.headers.get("x-robots-tag") ?? "").includes("noindex"), "unknown links are 404 and noindex");
  } catch (err) {
    line(false, "Worker", (err as Error).message);
  }
  if (failed) process.exit(1);
}

const HELP = `share — one file, one link

  share <file> [--expires 7d] [--name <shown name>] [--json] [--no-copy]
  share list [--limit 50] [--json]
  share rm <slug>
  share prune
  share doctor

Config: ${"$"}SHARE_CONFIG, else ~/.config/share/config.env (chmod 600). See README.`;

if (import.meta.main) {
  try {
    const args = parseArgs(Bun.argv.slice(2));
    if (args.command === "help") console.log(HELP);
    else if (args.command === "doctor") await doctor();
    else {
      const cfg = loadConfig();
      if (args.command === "upload") await upload(cfg, args);
      else if (args.command === "list") await list(cfg, args);
      else if (args.command === "rm") {
        await remove(cfg, args.target!);
        console.log(`removed ${args.target}`);
      } else if (args.command === "prune") await prune(cfg);
    }
  } catch (err) {
    console.error(`share: ${(err as Error).message}`);
    process.exit(1);
  }
}
