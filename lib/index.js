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
  writeExportFile
} from "./store.js";
const inject = ["webServer", "webRuntime"];
const name = "helloai-works";
const PREFIX = "/api/dsh-helloai-works";
const MAX_BODY = 256 * 1024 * 1024;
const DOWNLOAD_CHUNK = 4 * 1024 * 1024;
const POST_ROUTES = /* @__PURE__ */ new Set([
  `${PREFIX}/save`,
  `${PREFIX}/asset`,
  `${PREFIX}/export`,
  `${PREFIX}/import`,
  `${PREFIX}/collect`,
  `${PREFIX}/backups/restore`,
  `${PREFIX}/backups/delete`
]);
function json(res, status, payload) {
  const data = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": data.length,
    "cache-control": "no-store"
  });
  res.end(data);
}
function fail(message, statusCode = 400, code = "error.works.request") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const rejectOnce = (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.byteLength;
      if (size > limit) {
        rejectOnce(fail("\u8BF7\u6C42\u4F53\u8D85\u8FC7 256 MB \u9650\u5236", 413, "error.works.bodyTooLarge"));
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
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch (error) {
        rejectOnce(fail(`\u8BF7\u6C42\u4E0D\u662F\u6709\u6548 JSON\uFF1A${String(error)}`, 400, "error.works.invalidJson"));
      }
    });
  });
}
function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}
function requestAllowed(req, trustedHosts) {
  const host = String(req.headers.host || "").toLowerCase();
  let parsedHost;
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
    docPath: docPath()
  };
}
function registerRoute(ctx, route) {
  try {
    return ctx.webServer.register(route);
  } catch (error) {
    const table = ctx.webServer.prefixes;
    if (!(table instanceof Map) || !table.has(route.path)) throw error;
    table.delete(route.path);
    ctx.logger?.warn?.(`helloai-works: \u63A5\u7BA1\u4E86\u4E0A\u4E00\u6B21\u8FD0\u884C\u9057\u7559\u7684 API \u8DEF\u7531 ${route.path}`);
    return ctx.webServer.register(route);
  }
}
function mountRoute(ctx, route) {
  const mount = () => registerRoute(ctx, route);
  if (typeof ctx.effect === "function") ctx.effect(mount, "helloai-works api route");
  else mount();
}
function apply(ctx) {
  const trustedHosts = Array.isArray(ctx.webRuntime?.trustedHosts) ? ctx.webRuntime.trustedHosts : [];
  void ensureLayout().catch(() => void 0);
  mountRoute(ctx, {
    kind: "prefix",
    path: PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url || "/", "http://localhost");
      const path = url.pathname.replace(/\/+$/, "");
      try {
        if (!requestAllowed(req, trustedHosts)) {
          return json(res, 403, { ok: false, code: "error.works.origin", error: "\u8BF7\u6C42\u6765\u6E90\u4E0D\u53D7\u4FE1\u4EFB" });
        }
        if (req.method === "GET" && (path === `${PREFIX}/state` || path === `${PREFIX}/ping`)) {
          return json(res, 200, await state());
        }
        if (req.method === "GET" && path.startsWith(`${PREFIX}/asset/`)) {
          const assetId = decodeURIComponent(path.slice(`${PREFIX}/asset/`.length));
          const found = await readAsset(assetId);
          if (!found) return json(res, 404, { ok: false, code: "error.works.noAsset", error: "\u56FE\u7247\u4E0D\u5B58\u5728" });
          res.writeHead(200, {
            "content-type": found.info.mime,
            "content-length": found.bytes.length,
            "cache-control": "public, max-age=31536000, immutable",
            etag: `"${found.info.id}"`
          });
          return res.end(found.bytes);
        }
        if (req.method === "GET" && path === `${PREFIX}/download`) {
          const query = url.searchParams;
          const chunk = await readBackupChunk(
            query.get("name") || "",
            Number(query.get("offset") || 0),
            Number(query.get("length") || DOWNLOAD_CHUNK)
          );
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "content-length": chunk.data.byteLength,
            "cache-control": "no-store",
            "x-dsh-works-total": String(chunk.total),
            "x-dsh-works-offset": String(chunk.offset),
            "x-dsh-works-filename": chunk.filename
          });
          return res.end(chunk.data);
        }
        if (req.method === "GET" && path === `${PREFIX}/backups`) {
          const { directory, records } = await listBackups();
          return json(res, 200, { ok: true, directory, records });
        }
        if (req.method !== "POST") {
          const known = POST_ROUTES.has(path);
          return json(res, known ? 405 : 404, {
            ok: false,
            code: known ? "error.works.method" : "error.works.notFound",
            error: known ? "\u53EA\u652F\u6301 GET/POST" : "\u672A\u77E5\u63A5\u53E3"
          });
        }
        if (!POST_ROUTES.has(path)) {
          return json(res, 404, { ok: false, code: "error.works.notFound", error: "\u672A\u77E5\u63A5\u53E3" });
        }
        const body = await readBody(req);
        if (path === `${PREFIX}/save`) {
          const outcome = await saveDoc(body.doc ?? body, typeof body.baseRevision === "number" ? body.baseRevision : void 0);
          if (!outcome.ok) {
            return json(res, 409, {
              ok: false,
              code: "error.works.conflict",
              error: "\u8FD9\u4EFD\u8D44\u6599\u5728\u522B\u5904\u4E5F\u88AB\u4FEE\u6539\u8FC7",
              revision: outcome.doc.revision,
              updatedAt: outcome.doc.updatedAt,
              cards: outcome.doc.cards.length,
              doc: outcome.doc
            });
          }
          return json(res, 200, {
            ok: true,
            revision: outcome.doc.revision,
            updatedAt: outcome.doc.updatedAt,
            cards: outcome.doc.cards.length
          });
        }
        if (path === `${PREFIX}/asset`) {
          const info = await putAsset(String(body.data || ""), String(body.mime || ""));
          return json(res, 200, { ok: true, id: info.id, ext: info.ext, mime: info.mime, bytes: info.bytes });
        }
        if (path === `${PREFIX}/backups/restore`) {
          return json(res, 200, { ok: true, ...await restoreByName(String(body.name || "")) });
        }
        if (path === `${PREFIX}/backups/delete`) {
          return json(res, 200, { ok: true, ...await deleteBackup(String(body.name || "")) });
        }
        if (path === `${PREFIX}/export`) {
          const doc = await readDoc();
          return json(res, 200, { ok: true, ...await writeExportFile(doc) });
        }
        if (path === `${PREFIX}/import`) {
          const payload = body.payload ?? body;
          const result = await importPayload(payload);
          return json(res, 200, { ok: true, ...result });
        }
        if (path === `${PREFIX}/collect`) {
          const doc = sanitizeDoc(body.doc ?? await readDoc());
          return json(res, 200, { ok: true, ...await collectAssets(doc) });
        }
        return json(res, 404, { ok: false, code: "error.works.notFound", error: "\u672A\u77E5\u63A5\u53E3" });
      } catch (caught) {
        const error = caught;
        return json(res, error.statusCode || 500, {
          ok: false,
          code: error.code || "error.works.failed",
          error: error.message || String(error)
        });
      }
    }
  });
}
export {
  PREFIX,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
