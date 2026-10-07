/**
 * dsh-helloai-works — Host half.
 *
 * One prefix route serves the whole feature: read the document, save it, upload
 * an image, stream an image back, and manage the on-disk backups that make the
 * collection recoverable without this plugin.
 *
 * The page downloads a backup in chunks because the Desktop app relays
 * responses through a custom-protocol handler that cannot carry one
 * multi-megabyte body; uploads arrive as a single request body, which that
 * handler does not touch.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  assetList,
  collectAssets,
  deleteBackup,
  docPath,
  ensureLayout,
  importPayload,
  listBackups,
  putAsset,
  readAsset,
  readBackupChunk,
  readDoc,
  restoreByName,
  sanitizeDoc,
  saveDoc,
  worksRoot,
  writeExportFile,
} from "./store.js";
import type { ImportResult } from "./store.js";

type CodedError = Error & { statusCode?: number; code?: string };

/** Services this plugin needs from the Host; the loader resolves them first. */
const inject = ["webServer", "webRuntime"];
const name = "helloai-works";
const PREFIX = "/api/dsh-helloai-works";
/** Imports are single-shot request bodies; 256 MB of JSON is already generous. */
const MAX_BODY = 256 * 1024 * 1024;
const DOWNLOAD_CHUNK = 4 * 1024 * 1024;
/** Paths that only accept POST; anything else under the prefix is unknown. */
const POST_ROUTES = new Set([
  `${PREFIX}/save`,
  `${PREFIX}/asset`,
  `${PREFIX}/export`,
  `${PREFIX}/import`,
  `${PREFIX}/collect`,
  `${PREFIX}/backups/restore`,
  `${PREFIX}/backups/delete`,
]);

type Route = {
  kind: string;
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => unknown;
};

interface HostContext {
  webRuntime: { trustedHosts?: string[] };
  webServer: {
    register(route: Route): () => void;
    /** Live prefix table; read only to take over a route an older build leaked. */
    prefixes?: Map<string, unknown>;
  };
  effect?(execute: () => () => void, label?: string): unknown;
  logger?: { warn?(message: unknown): void };
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const data = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store",
  });
  res.end(data);
}

function fail(message: string, statusCode = 400, code = "error.works.request"): CodedError {
  const error = new Error(message) as CodedError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > limit) {
        rejectOnce(fail("请求体超过 256 MB 限制", 413, "error.works.bodyTooLarge"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", rejectOnce);
    req.on("end", () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      try {
        settled = true;
        resolveBody(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch (error) {
        rejectOnce(fail(`请求不是有效 JSON：${String(error)}`, 400, "error.works.invalidJson"));
      }
    });
  });
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

/** Same origin policy as the rest of the Host surface: loopback or a trusted host. */
function requestAllowed(req: IncomingMessage, trustedHosts: string[]): boolean {
  const host = String(req.headers.host || "").toLowerCase();
  let parsedHost: URL;
  try {
    parsedHost = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (isLoopbackHost(parsedHost.hostname)) return true;
  if (trustedHosts.map((item) => item.toLowerCase().split(":")[0]).includes(parsedHost.hostname)) return true;
  const origin = req.headers.origin;
  if (!origin || origin === "null") return true;
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

/** Compact state the page boots from: the document plus which assets exist. */
async function state() {
  const doc = await readDoc();
  const assets = await assetList();
  return {
    ok: true,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    doc,
    assets: assets.map((item) => item.id),
    root: worksRoot(),
    docPath: docPath(),
  };
}

/**
 * Register the prefix route so the plugin fiber owns the disposer.
 *
 * `apply` is a plain function, so cordis builds it with `new` and reads only
 * `init`/`initHooks` from the result: a disposer merely *returned* by `apply` is
 * dropped. The route then outlived its fiber, and the next activation failed
 * with `webserver: duplicate prefix route`. An effect keeps the disposer on the
 * fiber, so disabling the plugin removes the route again.
 */
function registerRoute(ctx: HostContext, route: Route): () => void {
  try {
    return ctx.webServer.register(route);
  } catch (error) {
    // A route leaked by an older build is still in the live table with no fiber
    // behind it; replace it so this activation owns the registration and can
    // dispose it. Anything else is a real composition error and must surface.
    const table = ctx.webServer.prefixes;
    if (!(table instanceof Map) || !table.has(route.path)) throw error;
    table.delete(route.path);
    ctx.logger?.warn?.(`helloai-works: 接管了上一次运行遗留的 API 路由 ${route.path}`);
    return ctx.webServer.register(route);
  }
}

/** Mount the route as a fiber effect, falling back for hosts without `effect`. */
function mountRoute(ctx: HostContext, route: Route): void {
  const mount = () => registerRoute(ctx, route);
  if (typeof ctx.effect === "function") ctx.effect(mount, "helloai-works api route");
  else mount();
}

function apply(ctx: HostContext): void {
  const trustedHosts = Array.isArray(ctx.webRuntime?.trustedHosts) ? ctx.webRuntime.trustedHosts : [];
  void ensureLayout().catch(() => undefined);

  mountRoute(ctx, {
    kind: "prefix",
    path: PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "");
      try {
        if (!requestAllowed(req, trustedHosts)) {
          return json(res, 403, { ok: false, code: "error.works.origin", error: "请求来源不受信任" });
        }

        if (req.method === "GET" && (path === `${PREFIX}/state` || path === `${PREFIX}/ping`)) {
          return json(res, 200, await state());
        }

        // Image bytes: immutable and content-addressed, so cache them hard.
        if (req.method === "GET" && path.startsWith(`${PREFIX}/asset/`)) {
          const assetId = decodeURIComponent(path.slice(`${PREFIX}/asset/`.length));
          const found = await readAsset(assetId);
          if (!found) return json(res, 404, { ok: false, code: "error.works.noAsset", error: "图片不存在" });
          res.writeHead(200, {
            "content-type": found.info.mime,
            "content-length": found.bytes.length,
            "cache-control": "public, max-age=31536000, immutable",
            etag: `"${found.info.id}"`,
          });
          return res.end(found.bytes);
        }

        if (req.method === "GET" && path === `${PREFIX}/download`) {
          const query = url.searchParams;
          const chunk = await readBackupChunk(
            query.get("name") || "",
            Number(query.get("offset") || 0),
            Number(query.get("length") || DOWNLOAD_CHUNK),
          );
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "content-length": chunk.data.byteLength,
            "cache-control": "no-store",
            "x-dsh-works-total": String(chunk.total),
            "x-dsh-works-offset": String(chunk.offset),
            "x-dsh-works-filename": chunk.filename,
          });
          return res.end(chunk.data);
        }

        if (req.method === "GET" && path === `${PREFIX}/backups`) {
          const { directory, records } = await listBackups();
          return json(res, 200, { ok: true, directory, records });
        }

        if (req.method !== "POST") {
          // A GET that matched nothing above is an unknown path; a POST-only
          // path reached with another method is a method error.
          const known = POST_ROUTES.has(path);
          return json(res, known ? 405 : 404, {
            ok: false,
            code: known ? "error.works.method" : "error.works.notFound",
            error: known ? "只支持 GET/POST" : "未知接口",
          });
        }
        if (!POST_ROUTES.has(path)) {
          return json(res, 404, { ok: false, code: "error.works.notFound", error: "未知接口" });
        }

        const body = await readBody(req);

        if (path === `${PREFIX}/save`) {
          const outcome = await saveDoc(body.doc ?? body, typeof body.baseRevision === "number" ? body.baseRevision : undefined);
          // A stale base revision is a conflict, not a failure: hand back the
          // current document so the page can offer a real choice.
          if (!outcome.ok) {
            return json(res, 409, {
              ok: false,
              code: "error.works.conflict",
              error: "这份资料在别处也被修改过",
              revision: outcome.doc.revision,
              updatedAt: outcome.doc.updatedAt,
              cards: outcome.doc.cards.length,
              doc: outcome.doc,
            });
          }
          return json(res, 200, {
            ok: true,
            revision: outcome.doc.revision,
            updatedAt: outcome.doc.updatedAt,
            cards: outcome.doc.cards.length,
          });
        }

        if (path === `${PREFIX}/asset`) {
          const info = await putAsset(String(body.data || ""), String(body.mime || ""));
          return json(res, 200, { ok: true, id: info.id, ext: info.ext, mime: info.mime, bytes: info.bytes });
        }

        if (path === `${PREFIX}/backups/restore`) {
          return json(res, 200, { ok: true, ...(await restoreByName(String(body.name || ""))) });
        }

        if (path === `${PREFIX}/backups/delete`) {
          return json(res, 200, { ok: true, ...(await deleteBackup(String(body.name || ""))) });
        }

        if (path === `${PREFIX}/export`) {
          const doc = await readDoc();
          return json(res, 200, { ok: true, ...(await writeExportFile(doc)) });
        }

        if (path === `${PREFIX}/import`) {
          const payload: unknown = body.payload ?? body;
          const result: ImportResult = await importPayload(payload);
          return json(res, 200, { ok: true, ...result });
        }

        if (path === `${PREFIX}/collect`) {
          const doc = sanitizeDoc(body.doc ?? (await readDoc()));
          return json(res, 200, { ok: true, ...(await collectAssets(doc)) });
        }

        return json(res, 404, { ok: false, code: "error.works.notFound", error: "未知接口" });
      } catch (caught) {
        const error = caught as CodedError;
        return json(res, error.statusCode || 500, {
          ok: false,
          code: error.code || "error.works.failed",
          error: error.message || String(error),
        });
      }
    },
  });
}

export { apply, inject, name, PREFIX };
