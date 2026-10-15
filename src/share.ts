/**
 * Share — the public, read-only half (logic; src/worker.ts is the entrypoint).
 *
 * This Worker answers GET and HEAD and nothing else. It reads one row from D1
 * and streams one object from R2. It never writes: uploads, removals and
 * expiry cleanup all happen from the owner's machine through `cli/share.ts`.
 * The test suite fails if a write call ever appears in this file.
 *
 * Routes:
 *   GET /               landing page (never lists shares)
 *   GET /:slug          preview page
 *   GET /:slug/raw      the bytes, range-capable; ?dl=1 forces a download
 *   GET /:slug/view     the file alone, filling the tab
 *   GET /favicon.svg    the mark
 *   GET /robots.txt     disallow everything
 */

export interface Env {
  SHARES: D1Database;
  FILES: R2Bucket;
}

export interface ShareMeta {
  slug: string;
  filename: string;
  size: number;
  mime: string;
  created_at: string;
  expires_at: string | null;
}

/** Base58 (no 0, O, I, l). The CLI mints 22 characters; anything outside 16–32 is not a share. */
export const SLUG_RE = /^[1-9A-HJ-NP-Za-km-z]{16,32}$/;

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

/** Escape every character that can break out of HTML text or a quoted attribute. */
export function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 1.4 MB, 903 KB, 12 B. Base-1000. */
export function humanSize(bytes: number): string {
  const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (n < 1000) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 2026-01-02T03:04:05Z → "2026-01-02 03:04 UTC". Falls back to the raw string. */
export function humanDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

const TEXT_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc", "md", "markdown", "txt", "log", "csv", "tsv",
  "yml", "yaml", "toml", "ini", "cfg", "conf", "sh", "bash", "zsh", "fish", "py", "rb", "go", "rs",
  "java", "kt", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "lua", "sql", "html", "htm", "css",
  "scss", "xml", "svg", "diff", "patch",
]);

export function extensionOf(filename: string): string {
  const base = filename.split("/").pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

export type PreviewKind = "video" | "image" | "audio" | "pdf" | "text" | "file";

export function previewKind(mime: string, filename: string): PreviewKind {
  const m = (mime || "").toLowerCase().split(";")[0]!.trim();
  if (m.startsWith("video/")) return "video";
  // SVG is an image to the browser but a document to an attacker: show it as text.
  if (m.startsWith("image/") && m !== "image/svg+xml") return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("text/") || m === "application/json" || m === "application/xml" || m === "image/svg+xml") return "text";
  if (TEXT_EXTENSIONS.has(extensionOf(filename))) return "text";
  return "file";
}

export function isPdf(mime: string): boolean {
  return (mime || "").toLowerCase().split(";")[0]!.trim() === "application/pdf";
}

export function isExpired(meta: Pick<ShareMeta, "expires_at">, now: Date): boolean {
  if (!meta.expires_at) return false;
  const t = Date.parse(meta.expires_at);
  return !Number.isNaN(t) && t <= now.getTime();
}

/** RFC 6266 / 5987 attachment header that survives quotes and non-ASCII names. */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** Turn R2's resolved range into concrete [start, end] offsets. */
export function resolveRange(range: R2Range | undefined, size: number): { start: number; end: number } {
  const last = Math.max(size - 1, 0);
  if (!range) return { start: 0, end: last };
  const r = range as { offset?: number; length?: number; suffix?: number };
  if (typeof r.suffix === "number") return { start: Math.max(size - r.suffix, 0), end: last };
  const start = typeof r.offset === "number" ? r.offset : 0;
  const end = typeof r.length === "number" ? start + r.length - 1 : last;
  return { start, end: Math.min(end, last) };
}

/* ------------------------------------------------------------------ *
 * Presentation
 * ------------------------------------------------------------------ */

/** The mark: a page whose top corner has been sent away. Source: assets/logo.svg. */
export const MARK = `<svg viewBox="0 0 128 128" aria-hidden="true"><rect width="128" height="128" rx="30" fill="#ff6b35"/><path d="M22 40h36l22 22v48H22z" fill="#fff4e8"/><path d="M58 40v22h22z" fill="#c2410c"/><path d="M71 52C73 36 82 25 96 24" fill="none" stroke="#fff4e8" stroke-width="10"/><path d="M92 8l24 16-24 16z" fill="#fff4e8"/></svg>`;

export const CSS = `
:root{
  --ground:#16121f;--ground-2:#201a2d;--edge:#342a47;--ink:#f6efe7;--dim:#a99bbd;
  --signal:#ff6b35;--signal-2:#ffa36c;
  --sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{min-height:100vh;display:flex;flex-direction:column;background:var(--ground);color:var(--ink);font:16px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(70vmax 50vmax at 50% -20%,rgba(255,107,53,.16),transparent 65%)}
header,main,footer{position:relative}
header{display:flex;align-items:center;justify-content:center;gap:12px;padding:22px 20px}
header a{display:flex;align-items:center;gap:12px;color:inherit;text-decoration:none}
header svg{width:36px;height:36px}
header b{font-weight:800;font-size:20px;letter-spacing:-.01em}
main{width:100%;max-width:1040px;margin:0 auto;padding:24px 20px 72px;flex:1;text-align:center}
h1{margin:8px 0 14px;font-size:clamp(30px,5.5vw,56px);line-height:1.05;letter-spacing:-.025em;font-weight:800;word-break:break-word}
.chips{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin:0 0 28px;padding:0;list-style:none}
.chips li{padding:5px 12px;border:1px solid var(--edge);border-radius:999px;background:var(--ground-2);color:var(--dim);font:13px/1.4 var(--mono)}
.chips li b{color:var(--signal-2);font-weight:600}
.stage{border:1px solid var(--edge);border-radius:18px;background:var(--ground-2);overflow:hidden;text-align:left;box-shadow:0 30px 80px rgba(0,0,0,.45)}
.stage video,.stage img{display:block;width:100%;max-height:78vh;object-fit:contain;background:#0d0a13}
.stage audio{display:block;width:calc(100% - 48px);margin:28px 24px}
.stage embed{display:block;width:100%;height:80vh;border:0}
pre{margin:0;padding:22px;max-height:78vh;overflow:auto;font:13px/1.6 var(--mono);color:#ece3f5;white-space:pre;tab-size:2}
.file{padding:56px 24px;text-align:center;color:var(--dim)}
.file svg{width:88px;height:88px;margin-bottom:14px}
.actions{display:flex;flex-wrap:wrap;justify-content:center;gap:12px;margin-top:26px}
.actions a{padding:12px 22px;border-radius:12px;text-decoration:none;font-weight:700;color:#1a0f08;background:var(--signal);transition:transform .15s ease,background .15s ease}
.actions a.alt{background:transparent;color:var(--ink);border:1px solid var(--edge)}
.actions a:hover{transform:translateY(-1px);background:var(--signal-2)}
.actions a.alt:hover{background:var(--ground-2)}
.state{max-width:620px;margin:10vh auto 0}
.state .code{font:800 96px/1 var(--sans);letter-spacing:-.04em;color:var(--signal)}
.state p{color:var(--dim)}
.fs{position:fixed;inset:0;max-width:none;padding:0;margin:0;display:flex;align-items:center;justify-content:center;background:#0d0a13}
.fs>*{width:100%;height:100%;border:0;object-fit:contain}
.fs>audio{height:auto;max-width:720px;padding:0 24px}
footer{padding:18px 20px;text-align:center;font:12px/1.4 var(--mono);color:var(--dim)}
@media (prefers-reduced-motion:reduce){.actions a{transition:none}.actions a:hover{transform:none}}
`;

/** The only inline script any page carries: it fills a text preview with at most the first 256 KB. Admitted by hash. */
export const TEXT_SCRIPT = `(function(){var el=document.getElementById("text"),cap=262144;fetch(el.getAttribute("data-src"),{headers:{Range:"bytes=0-"+(cap-1)}}).then(function(r){var total=+((r.headers.get("content-range")||"").split("/")[1]||0);return r.text().then(function(t){el.textContent=total>cap?t+"\\n\\n[Preview stops at 256 KB. Download for the whole file.]":t})}).catch(function(){el.textContent="Could not load this file."})})();`;

/** base64(sha256(...)) of CSS and TEXT_SCRIPT. The tests recompute both and fail on drift. */
export const CSS_HASH = "zmCkaMiyEXARJYbzlnveEpTJDsp7RfyoHdX9ngPd1vM=";
export const SCRIPT_HASH = "Nu/HnHn6nVJwuHMxMPnXOIi2DvmiqVrnY6lZz5UTv/E=";

/** Page CSP: same-origin media, the one stylesheet and one script by hash, nothing else. */
export const PAGE_CSP = [
  "default-src 'none'",
  "img-src 'self'",
  "media-src 'self'",
  "object-src 'self'",
  "frame-src 'self'",
  "connect-src 'self'",
  `style-src 'sha256-${CSS_HASH}'`,
  `script-src 'sha256-${SCRIPT_HASH}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** Raw bytes run in a sandbox: an uploaded HTML or SVG gets an opaque origin and no script. */
export const RAW_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";

function shell(host: string, title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${head}<style>${CSS}</style>
</head>
<body>
<header><a href="/">${MARK}<b>${escapeHtml(host)}</b></a></header>
${body}
<footer>Private link · reachable only by its exact address</footer>
</body>
</html>`;
}

const FILE_GLYPH = `<svg viewBox="0 0 128 128" aria-hidden="true"><path d="M34 14h44l26 26v74H34z" fill="none" stroke="#a99bbd" stroke-width="6" stroke-linejoin="round"/><path d="M78 14v26h26" fill="none" stroke="#ff6b35" stroke-width="6" stroke-linejoin="round"/></svg>`;

export function renderPreview(host: string, meta: ShareMeta): string {
  const slug = encodeURIComponent(meta.slug);
  const name = escapeHtml(meta.filename);
  const raw = escapeHtml(`/${slug}/raw`);
  const kind = previewKind(meta.mime, meta.filename);
  const mime = escapeHtml(meta.mime || "application/octet-stream");

  // Unfurls: images and videos show themselves; everything else gets a text card.
  const origin = `https://${host}`;
  const absRaw = escapeHtml(`${origin}/${slug}/raw`);
  const og =
    `<meta property="og:site_name" content="${escapeHtml(host)}">\n` +
    `<meta property="og:title" content="${name}">\n` +
    `<meta property="og:description" content="${escapeHtml(humanSize(meta.size))} · ${mime}">\n` +
    `<meta property="og:url" content="${escapeHtml(`${origin}/${slug}`)}">\n` +
    (kind === "image" ? `<meta property="og:image" content="${absRaw}">\n<meta name="twitter:card" content="summary_large_image">\n` : "") +
    (kind === "video" ? `<meta property="og:type" content="video.other">\n<meta property="og:video" content="${absRaw}">\n<meta property="og:video:type" content="${mime}">\n` : "");

  let stage: string;
  switch (kind) {
    case "video":
      stage = `<video controls playsinline preload="metadata" src="${raw}"></video>`;
      break;
    case "image":
      stage = `<img src="${raw}" alt="${name}">`;
      break;
    case "audio":
      stage = `<audio controls preload="metadata" src="${raw}"></audio>`;
      break;
    case "pdf":
      stage = `<embed src="${raw}" type="application/pdf">`;
      break;
    case "text":
      stage = `<pre id="text" data-src="${raw}">Loading…</pre>\n<script>${TEXT_SCRIPT}</script>`;
      break;
    default:
      stage = `<div class="file">${FILE_GLYPH}<p>No in-browser preview for this type. Download it to open.</p></div>`;
  }

  const body = `<main>
<h1>${name}</h1>
<ul class="chips"><li><b>${escapeHtml(humanSize(meta.size))}</b></li><li>${mime}</li><li>${escapeHtml(humanDate(meta.created_at))}</li>${
    meta.expires_at ? `<li>expires ${escapeHtml(humanDate(meta.expires_at))}</li>` : ""
  }</ul>
<div class="stage">${stage}</div>
<div class="actions"><a href="${raw}?dl=1">Download</a>${kind === "file" ? "" : `<a class="alt" href="${escapeHtml(`/${slug}/view`)}">Full screen</a>`}</div>
</main>`;
  return shell(host, meta.filename, body, og);
}

export function renderFullscreen(host: string, meta: ShareMeta): string {
  const name = escapeHtml(meta.filename);
  const raw = escapeHtml(`/${encodeURIComponent(meta.slug)}/raw`);
  const kind = previewKind(meta.mime, meta.filename);
  const el =
    kind === "image" ? `<img src="${raw}" alt="${name}">`
    : kind === "video" ? `<video controls autoplay playsinline src="${raw}"></video>`
    : kind === "audio" ? `<audio controls autoplay src="${raw}"></audio>`
    : kind === "pdf" ? `<embed src="${raw}" type="application/pdf">`
    : `<iframe src="${raw}" title="${name}" sandbox></iframe>`;
  return shell(host, meta.filename, `<main class="fs">${el}</main>`);
}

export function renderState(host: string, code: number, heading: string, note: string): string {
  return shell(
    host,
    `${code} · ${heading}`,
    `<main><div class="state"><div class="code">${code}</div><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(note)}</p></div></main>`,
  );
}

export function renderLanding(host: string): string {
  return shell(
    host,
    host,
    `<main><div class="state"><h1>One file, one link.</h1><p>Everything here is reachable only by its exact address. Nothing is listed and nothing is indexed.</p></div></main>`,
  );
}

/* ------------------------------------------------------------------ *
 * Responses
 * ------------------------------------------------------------------ */

function baseHeaders(): Headers {
  const h = new Headers();
  h.set("X-Robots-Tag", "noindex, nofollow");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Strict-Transport-Security", "max-age=31536000");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return h;
}

function page(markup: string, status: number): Response {
  const h = baseHeaders();
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Content-Security-Policy", PAGE_CSP);
  // no-store: a removed or expired link must stop working on the next request, cached copies included.
  h.set("Cache-Control", "no-store");
  return new Response(markup, { status, headers: h });
}

function text(body: string, status: number, type = "text/plain; charset=utf-8"): Response {
  const h = baseHeaders();
  h.set("Content-Type", type);
  h.set("Cache-Control", "no-store");
  return new Response(body, { status, headers: h });
}

async function serveRaw(env: Env, request: Request, host: string, meta: ShareMeta, download: boolean, head: boolean): Promise<Response> {
  // The object key is the slug alone; the file name lives only in D1, so no name can change which object is read.
  const key = meta.slug;
  const missing = () => page(renderState(host, 404, "File missing", "The link is valid but the file is gone."), 404);
  const h = baseHeaders();
  h.set("Content-Type", meta.mime || "application/octet-stream");
  // Everything runs sandboxed except PDFs: browsers refuse to start their PDF viewer in a sandboxed
  // document, and that viewer runs outside this origin anyway. The type is pinned and nosniff is set.
  if (!isPdf(meta.mime)) h.set("Content-Security-Policy", RAW_CSP);
  h.set("Accept-Ranges", "bytes");
  h.set("Cache-Control", "no-store");
  if (download) h.set("Content-Disposition", contentDisposition(meta.filename));

  if (head) {
    const obj = await env.FILES.head(key);
    if (!obj) return missing();
    h.set("Content-Length", String(obj.size));
    h.set("ETag", obj.httpEtag);
    return new Response(null, { status: 200, headers: h });
  }

  const obj = await env.FILES.get(key, { range: request.headers, onlyIf: request.headers });
  if (!obj) return missing();
  h.set("ETag", obj.httpEtag);
  if (!("body" in obj) || obj.body === null) {
    // R2 returns metadata only when a precondition fails: If-Match / If-Unmodified-Since mean 412, the rest 304.
    const strict = request.headers.has("if-match") || request.headers.has("if-unmodified-since");
    return new Response(null, { status: strict ? 412 : 304, headers: h });
  }

  if (obj.range !== undefined && request.headers.has("range")) {
    const { start, end } = resolveRange(obj.range, obj.size);
    h.set("Content-Range", `bytes ${start}-${end}/${obj.size}`);
    h.set("Content-Length", String(end - start + 1));
    return new Response(obj.body, { status: 206, headers: h });
  }
  h.set("Content-Length", String(obj.size));
  return new Response(obj.body, { status: 200, headers: h });
}

/** The whole router. src/worker.ts is the entrypoint that hands requests here. */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      const r = text("Only GET and HEAD are answered here.\n", 405);
      r.headers.set("Allow", "GET, HEAD");
      return r;
    }
    const head = method === "HEAD";
    const url = new URL(request.url);
    const host = url.host;
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 0) return page(renderLanding(host), 200);
    if (parts.length === 1 && parts[0] === "robots.txt") return text("User-agent: *\nDisallow: /\n", 200);
    if (parts.length === 1 && parts[0] === "favicon.svg") {
      const r = text(MARK.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" '), 200, "image/svg+xml");
      r.headers.set("Cache-Control", "public, max-age=86400");
      return r;
    }

    const notHere = (note: string) => page(renderState(host, 404, "Not here", note), 404);
    const sub = parts[1];
    if (parts.length > 2 || (sub !== undefined && sub !== "raw" && sub !== "view")) return notHere("Nothing lives at this path.");

    const slug = parts[0]!;
    if (!SLUG_RE.test(slug)) return notHere("That link does not look like a share.");

    const row = await env.SHARES.prepare("SELECT slug, filename, size, mime, created_at, expires_at FROM shares WHERE slug = ?")
      .bind(slug)
      .first<ShareMeta>();
    if (!row) return notHere("This link never existed, or it was removed.");
    if (isExpired(row, new Date())) return page(renderState(host, 410, "Expired", "This link had an expiry and it has passed."), 410);

    if (sub === "raw") return serveRaw(env, request, host, row, url.searchParams.get("dl") === "1", head);
    if (sub === "view") return page(renderFullscreen(host, row), 200);
    return page(renderPreview(host, row), 200);
  }
}
