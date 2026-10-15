import { describe, expect, test } from "bun:test";
import worker from "../src/worker.ts";
import {
  CSS, CSS_HASH, PAGE_CSP, SCRIPT_HASH, SLUG_RE, TEXT_SCRIPT, contentDisposition, escapeHtml, isExpired, previewKind, renderPreview,
  type Env, type ShareMeta,
} from "../src/share.ts";

const SLUG = "7HqXk2mPzR4tYb9wNcVd3e";
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("base64");

function row(over: Partial<ShareMeta> = {}): ShareMeta {
  return { slug: SLUG, filename: "demo.txt", size: 5, mime: "text/plain", created_at: "2026-01-02T03:04:05Z", expires_at: null, ...over };
}

/** A fake D1 and R2 that hold one share, and record every SQL string they are handed. */
function env(rows: ShareMeta[] = [row()], bytes = "hello", bodyless = false): Env & { sql: string[] } {
  const sql: string[] = [];
  const obj = {
    size: bytes.length, httpEtag: '"e"', range: undefined, body: bodyless ? null : new Blob([bytes]).stream(),
    writeHttpMetadata() {},
  };
  return {
    sql,
    SHARES: {
      prepare(q: string) {
        sql.push(q);
        return { bind: (slug: string) => ({ first: async () => rows.find((r) => r.slug === slug) ?? null }) };
      },
    } as unknown as D1Database,
    FILES: {
      get: async (key: string) => (rows.some((r) => key === r.slug) ? obj : null),
      head: async (key: string) => (rows.some((r) => key === r.slug) ? obj : null),
    } as unknown as R2Bucket,
  };
}

const get = (path: string, e = env(), init: RequestInit = {}) => worker.fetch(new Request(`https://share.example.com${path}`, init), e);

describe("method", () => {
  test("405 for POST, PUT, DELETE, PATCH", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = await get("/", env(), { method });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("GET, HEAD");
    }
  });
});

describe("source", () => {
  test("worker never writes: no put, delete, INSERT, UPDATE or DELETE FROM in its code", async () => {
    const src = (await Bun.file(new URL("../src/share.ts", import.meta.url)).text()) + (await Bun.file(new URL("../src/worker.ts", import.meta.url)).text());
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // A regression check, not a proof: catches the obvious spellings of R2 and D1 mutations.
    expect(code).not.toMatch(/\b(put|delete|createMultipartUpload|resumeMultipartUpload|exec|batch|dump)\s*\(/);
    expect(code).not.toMatch(/\[\s*["'`](put|delete|exec|batch)["'`]\s*\]/);
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA)\b/);
  });
  test("the only SQL the worker runs is a SELECT", async () => {
    const e = env();
    await get(`/${SLUG}`, e);
    expect(e.sql.length).toBe(1);
    expect(e.sql[0]!.startsWith("SELECT ")).toBe(true);
  });
});

describe("routes", () => {
  test("landing never lists shares", async () => {
    const e = env();
    const r = await get("/", e);
    expect(r.status).toBe(200);
    expect(e.sql.length).toBe(0);
    expect(await r.text()).not.toContain(SLUG);
  });
  test("robots.txt disallows everything", async () => {
    expect(await (await get("/robots.txt")).text()).toBe("User-agent: *\nDisallow: /\n");
  });
  test("malformed slug is 404 without touching D1", async () => {
    for (const p of ["/abc", "/0OIl0OIl0OIl0OIl0OIl", `/${SLUG}/secret`, `/${SLUG}/raw/x`, "/../etc/passwd"]) {
      const e = env();
      expect((await get(p, e)).status).toBe(404);
      expect(e.sql.length).toBe(0);
    }
  });
  test("unknown slug is 404", async () => {
    expect((await get("/7HqXk2mPzR4tYb9wNcVd3f")).status).toBe(404);
  });
  test("expired share is 410 on every route", async () => {
    const e = env([row({ expires_at: "2020-01-01T00:00:00Z" })]);
    for (const p of [`/${SLUG}`, `/${SLUG}/raw`, `/${SLUG}/view`]) expect((await get(p, e)).status).toBe(410);
  });
  test("raw serves the bytes", async () => {
    const r = await get(`/${SLUG}/raw`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("hello");
  });
  test("?dl=1 sets an attachment disposition", async () => {
    expect((await get(`/${SLUG}/raw?dl=1`)).headers.get("content-disposition")).toStartWith("attachment;");
  });
});

describe("conditional", () => {
  test("a failed If-Match is 412, a matched If-None-Match is 304", async () => {
    expect((await get(`/${SLUG}/raw`, env([row()], "hello", true), { headers: { "if-match": '"x"' } })).status).toBe(412);
    expect((await get(`/${SLUG}/raw`, env([row()], "hello", true), { headers: { "if-none-match": '"e"' } })).status).toBe(304);
  });
  test("the object key is the slug, whatever the file name", async () => {
    const r = await get(`/${SLUG}/raw`, env([row({ filename: "a?b#c.txt" })]));
    expect(r.status).toBe(200);
  });
});

describe("headers", () => {
  test("nothing is cacheable, so removal and expiry hold on the next open", async () => {
    for (const p of ["/", "/robots.txt", "/nope", `/${SLUG}`, `/${SLUG}/raw`, `/${SLUG}/view`]) expect((await get(p)).headers.get("cache-control")).toBe("no-store");
  });
  test("every response is noindex, no-referrer and nosniff", async () => {
    for (const p of ["/", "/robots.txt", "/nope", `/${SLUG}`, `/${SLUG}/raw`, `/${SLUG}/view`]) {
      const h = (await get(p)).headers;
      expect(h.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(h.get("referrer-policy")).toBe("no-referrer");
      expect(h.get("x-content-type-options")).toBe("nosniff");
    }
  });
  test("raw bytes are sandboxed", async () => {
    for (const method of ["GET", "HEAD"]) {
      const csp = (await get(`/${SLUG}/raw`, env(), { method })).headers.get("content-security-policy") ?? "";
      expect(csp.startsWith("sandbox")).toBe(true);
    }
  });
  test("PDFs alone skip the sandbox, keeping their pinned type and nosniff", async () => {
    const e = env([row({ filename: "a.pdf", mime: "application/pdf" })]);
    const h = (await get(`/${SLUG}/raw`, e)).headers;
    expect(h.get("content-security-policy")).toBeNull();
    expect(h.get("content-type")).toBe("application/pdf");
    expect(h.get("x-content-type-options")).toBe("nosniff");
    const html = (await get(`/${SLUG}/raw`, env([row({ filename: "x.html", mime: "text/html" })]))).headers;
    expect(html.get("content-security-policy")!.startsWith("sandbox")).toBe(true);
  });
  test("pages carry the hashed CSP and the hashes match the content", async () => {
    expect(sha(CSS)).toBe(CSS_HASH);
    expect(sha(TEXT_SCRIPT)).toBe(SCRIPT_HASH);
    expect((await get(`/${SLUG}`)).headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(PAGE_CSP).not.toContain("unsafe-inline");
  });
});

describe("escaping", () => {
  test("escapes a hostile filename everywhere it appears", async () => {
    const evil = `"><script>alert(1)</script><img src=x onerror=alert(2)>.txt`;
    const html = renderPreview("share.example.com", row({ filename: evil, mime: `text/plain"><script>` }));
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain(`"><script>`);
    // the only <script> is the hashed text loader
    expect(html.match(/<script>/g)?.length).toBe(1);
    expect(html).toContain(`<script>${TEXT_SCRIPT}</script>`);
  });
  test("escapeHtml covers all five characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
  test("content disposition survives quotes and non-ASCII", () => {
    expect(contentDisposition(`a"b\\ü.txt`)).toBe(`attachment; filename="a_b__.txt"; filename*=UTF-8''a%22b%5C%C3%BC.txt`);
  });
});

describe("kinds", () => {
  test("SVG and HTML are shown as text, never rendered inline", () => {
    expect(previewKind("image/svg+xml", "x.svg")).toBe("text");
    expect(previewKind("text/html", "x.html")).toBe("text");
    expect(previewKind("image/png", "x.png")).toBe("image");
    expect(previewKind("application/octet-stream", "x.zip")).toBe("file");
    expect(previewKind("application/pdf; charset=utf-8", "x.pdf")).toBe("pdf");
    expect(previewKind("Image/SVG+XML; charset=utf-8", "x.svg")).toBe("text");
  });
});

describe("slug and expiry", () => {
  test("slug pattern is base58, 16 to 32 characters", () => {
    expect(SLUG_RE.test(SLUG)).toBe(true);
    expect(SLUG_RE.test("a".repeat(15))).toBe(false);
    expect(SLUG_RE.test("a".repeat(33))).toBe(false);
    expect(SLUG_RE.test("0".repeat(22))).toBe(false);
  });
  test("expired at or after the expiry instant", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(isExpired({ expires_at: null }, now)).toBe(false);
    expect(isExpired({ expires_at: "2026-01-01T00:00:00Z" }, now)).toBe(true);
    expect(isExpired({ expires_at: "2026-01-01T00:00:01Z" }, now)).toBe(false);
  });
});
