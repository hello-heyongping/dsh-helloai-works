import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
const DOC_VERSION = 1;
const EXPORT_FORMAT = "dsh-helloai-works";
const SNAPSHOT_LIMIT = 30;
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1e3;
const MAX_ASSET_BASE64 = 32 * 1024 * 1024;
const MAX_CARDS = 2e4;
const MAX_BLOCKS = 2e3;
const MAX_TEXT = 2e5;
const MAX_TITLE = 400;
const MAX_TAG_NAME = 80;
const MAX_SOURCE = 2e3;
const ASSET_ID = /^[a-f0-9]{40}$/;
const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg"
};
const EXT_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml"
};
function dshHome() {
  return resolve(process.env.DSH_HOME || join(homedir(), ".dsh"));
}
function worksRoot() {
  return join(dshHome(), "helloai-works");
}
function docPath() {
  return join(worksRoot(), "works.json");
}
function assetsDir() {
  return join(worksRoot(), "assets");
}
function backupsDir() {
  return join(worksRoot(), "backups");
}
async function ensureLayout() {
  await mkdir(assetsDir(), { recursive: true });
  await mkdir(backupsDir(), { recursive: true });
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function stamp(date = /* @__PURE__ */ new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}
function text(value, limit, fallback = "") {
  return typeof value === "string" ? value.slice(0, limit) : fallback;
}
function isoOrNow(value) {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return nowIso();
}
function id(value) {
  if (typeof value === "string" && value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value)) return value;
  return randomUUID().replace(/-/g, "").slice(0, 24);
}
function emptyDoc() {
  return { version: DOC_VERSION, revision: 1, updatedAt: nowIso(), tags: [], cards: [] };
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
let queue = Promise.resolve();
function serialize(task) {
  const run = queue.then(task, task);
  queue = run.then(
    () => void 0,
    () => void 0
  );
  return run;
}
async function writeFileAtomic(path, data) {
  const temp = `${path}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temp, "w");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = void 0;
    await rename(temp, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => void 0);
    await rm(temp, { force: true }).catch(() => void 0);
    throw error;
  }
}
function sanitizeDoc(raw) {
  const input = raw ?? {};
  const tags = [];
  const seenTag = /* @__PURE__ */ new Set();
  for (const item of Array.isArray(input.tags) ? input.tags : []) {
    const candidate = item ?? {};
    const tagId = id(candidate.id);
    const tagName = text(candidate.name, MAX_TAG_NAME).trim();
    if (!tagName || seenTag.has(tagId)) continue;
    seenTag.add(tagId);
    tags.push({ id: tagId, name: tagName });
  }
  const cards = [];
  const seenCard = /* @__PURE__ */ new Set();
  for (const item of (Array.isArray(input.cards) ? input.cards : []).slice(0, MAX_CARDS)) {
    const candidate = item ?? {};
    const cardId = id(candidate.id);
    if (seenCard.has(cardId)) continue;
    seenCard.add(cardId);
    const blocks = [];
    for (const block of (Array.isArray(candidate.blocks) ? candidate.blocks : []).slice(0, MAX_BLOCKS)) {
      const entry = block ?? {};
      const blockId = id(entry.id);
      if (entry.kind === "image") {
        const asset = text(entry.asset, 64);
        if (!ASSET_ID.test(asset)) continue;
        blocks.push({ id: blockId, kind: "image", asset, caption: text(entry.caption, MAX_TEXT) });
      } else {
        const body = text(entry.text, MAX_TEXT);
        blocks.push({ id: blockId, kind: "text", text: body });
      }
    }
    const cardTags = (Array.isArray(candidate.tags) ? candidate.tags : []).map((value) => typeof value === "string" ? value : "").filter((value) => value && seenTag.has(value));
    cards.push({
      id: cardId,
      title: text(candidate.title, MAX_TITLE),
      tags: [...new Set(cardTags)],
      source: text(candidate.source, MAX_SOURCE),
      blocks,
      createdAt: isoOrNow(candidate.createdAt),
      updatedAt: isoOrNow(candidate.updatedAt)
    });
  }
  return {
    version: DOC_VERSION,
    revision: Number.isFinite(input.revision) ? Math.max(1, Math.floor(Number(input.revision))) : 1,
    updatedAt: isoOrNow(input.updatedAt),
    tags,
    cards
  };
}
async function readDoc() {
  await ensureLayout();
  try {
    const parsed = JSON.parse(await readFile(docPath(), "utf8"));
    const doc = sanitizeDoc(parsed);
    doc.revision = Number.isFinite(parsed?.revision) ? Math.max(1, Math.floor(parsed.revision)) : 1;
    return doc;
  } catch {
    return emptyDoc();
  }
}
function sameContent(a, b) {
  return JSON.stringify({ tags: a.tags, cards: a.cards }) === JSON.stringify({ tags: b.tags, cards: b.cards });
}
async function saveDoc(raw, baseRevision) {
  return serialize(async () => {
    await ensureLayout();
    const current = await readDoc();
    if (typeof baseRevision === "number" && Number.isFinite(baseRevision) && baseRevision !== current.revision) {
      return { ok: false, doc: current };
    }
    const doc = sanitizeDoc(raw);
    if (sameContent(current, doc)) return { ok: true, doc: current };
    doc.revision = current.revision + 1;
    doc.updatedAt = nowIso();
    await maybeSnapshot(current).catch(() => void 0);
    await writeFileAtomic(docPath(), JSON.stringify(doc));
    return { ok: true, doc };
  });
}
async function replaceDoc(doc) {
  return serialize(async () => {
    await ensureLayout();
    const current = await readDoc();
    doc.revision = current.revision + 1;
    doc.updatedAt = nowIso();
    await writeFileAtomic(docPath(), JSON.stringify(doc));
    return doc;
  });
}
function sha1(bytes) {
  return createHash("sha1").update(bytes).digest("hex");
}
let assetIndex;
async function refreshAssetIndex() {
  await mkdir(assetsDir(), { recursive: true });
  const index = /* @__PURE__ */ new Map();
  for (const entry of await readdir(assetsDir(), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot <= 0) continue;
    const assetId = entry.name.slice(0, dot);
    const ext = entry.name.slice(dot + 1).toLowerCase();
    const mime = EXT_MIME[ext];
    if (!mime || !ASSET_ID.test(assetId)) continue;
    const info = await stat(join(assetsDir(), entry.name)).catch(() => void 0);
    if (!info?.isFile()) continue;
    index.set(assetId, { id: assetId, ext, mime, bytes: info.size, modifiedAt: info.mtime.toISOString() });
  }
  assetIndex = index;
  return index;
}
async function assetList() {
  const index = assetIndex ?? await refreshAssetIndex();
  return [...index.values()].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}
function assetFile(info) {
  return join(assetsDir(), `${info.id}.${info.ext}`);
}
async function putAsset(dataBase64, declaredMime) {
  const payload = dataBase64.includes(",") ? dataBase64.slice(dataBase64.indexOf(",") + 1) : dataBase64;
  if (payload.length > MAX_ASSET_BASE64) throw Object.assign(new Error("\u56FE\u7247\u8FC7\u5927"), { statusCode: 413 });
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength === 0) throw Object.assign(new Error("\u56FE\u7247\u5185\u5BB9\u4E3A\u7A7A"), { statusCode: 400 });
  const mime = MIME_EXT[declaredMime] ? declaredMime : sniffMime(bytes);
  const ext = MIME_EXT[mime];
  if (!ext) throw Object.assign(new Error(`\u4E0D\u652F\u6301\u7684\u56FE\u7247\u683C\u5F0F\uFF1A${declaredMime || "\u672A\u77E5"}`), { statusCode: 415 });
  await mkdir(assetsDir(), { recursive: true });
  const assetId = sha1(bytes);
  const target = join(assetsDir(), `${assetId}.${ext}`);
  if (!await exists(target)) await writeFileAtomic(target, bytes);
  const info = { id: assetId, ext, mime, bytes: bytes.byteLength, modifiedAt: nowIso() };
  if (assetIndex) assetIndex.set(assetId, info);
  return info;
}
function sniffMime(bytes) {
  if (bytes.length > 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return "image/png";
  if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length > 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length > 12 && bytes.subarray(4, 12).toString("ascii").startsWith("ftypavif")) return "image/avif";
  if (bytes.length > 2 && bytes[0] === 66 && bytes[1] === 77) return "image/bmp";
  return "";
}
async function readAsset(assetId) {
  if (!ASSET_ID.test(assetId)) return void 0;
  const index = assetIndex ?? await refreshAssetIndex();
  const info = index.get(assetId);
  if (!info) return void 0;
  try {
    return { info, bytes: await readFile(assetFile(info)) };
  } catch {
    assetIndex?.delete(assetId);
    return void 0;
  }
}
async function collectAssets(doc) {
  return serialize(async () => {
    const referenced = /* @__PURE__ */ new Set();
    for (const card of doc.cards) {
      for (const block of card.blocks) if (block.kind === "image") referenced.add(block.asset);
    }
    const index = await refreshAssetIndex();
    let removed = 0;
    let bytes = 0;
    for (const [assetId, info] of index) {
      if (referenced.has(assetId)) continue;
      await rm(assetFile(info), { force: true });
      bytes += info.bytes;
      removed += 1;
    }
    if (removed) await refreshAssetIndex();
    return { removed, bytes, kept: referenced.size };
  });
}
const SNAPSHOT_NAME = /^works-\d{8}-\d{6}\.json$/;
async function rotateSnapshots() {
  const entries = (await readdir(backupsDir())).filter((name) => SNAPSHOT_NAME.test(name)).sort();
  const stale = entries.slice(0, Math.max(0, entries.length - SNAPSHOT_LIMIT));
  for (const name of stale) await rm(join(backupsDir(), name), { force: true });
}
async function freeSnapshotName() {
  for (let step = 0; step < 120; step += 1) {
    const name = `works-${stamp(new Date(Date.now() + step * 1e3))}.json`;
    if (!await exists(join(backupsDir(), name))) return name;
  }
  return `works-${stamp()}.json`;
}
async function snapshotDoc(doc) {
  await ensureLayout();
  const name = await freeSnapshotName();
  await writeFileAtomic(join(backupsDir(), name), JSON.stringify({ [EXPORT_FORMAT]: true, kind: "snapshot", savedAt: nowIso(), doc }, null, 0));
  await rotateSnapshots();
  return name;
}
let lastSnapshotAt = 0;
async function maybeSnapshot(doc, force = false) {
  const now = Date.now();
  if (!force && now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return void 0;
  const name = await snapshotDoc(doc);
  lastSnapshotAt = now;
  return name;
}
async function listBackups() {
  await ensureLayout();
  const records = [];
  for (const name of await readdir(backupsDir())) {
    if (!name.endsWith(".json")) continue;
    const info = await stat(join(backupsDir(), name)).catch(() => void 0);
    if (!info?.isFile()) continue;
    records.push({
      name,
      kind: name.startsWith("works-full-") ? "full" : "snapshot",
      bytes: info.size,
      modifiedAt: info.mtime.toISOString()
    });
  }
  records.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || b.name.localeCompare(a.name));
  return { directory: backupsDir(), records };
}
function backupFile(name) {
  if (!/^works-(full-)?\d{8}-\d{6}\.json$/.test(name)) {
    throw Object.assign(new Error("\u5907\u4EFD\u6587\u4EF6\u540D\u4E0D\u5408\u6CD5"), { statusCode: 400 });
  }
  return join(backupsDir(), name);
}
async function deleteBackup(name) {
  const file = backupFile(name);
  if (!await exists(file)) throw Object.assign(new Error("\u5907\u4EFD\u4E0D\u5B58\u5728"), { statusCode: 404 });
  await rm(file, { force: true });
  return { deleted: name };
}
async function buildExport(doc) {
  const referenced = /* @__PURE__ */ new Set();
  for (const card of doc.cards) {
    for (const block of card.blocks) if (block.kind === "image") referenced.add(block.asset);
  }
  const assets = {};
  for (const assetId of referenced) {
    const found = await readAsset(assetId);
    if (found) assets[assetId] = { mime: found.info.mime, data: found.bytes.toString("base64") };
  }
  return { format: EXPORT_FORMAT, version: DOC_VERSION, exportedAt: nowIso(), doc, assets };
}
async function writeExportFile(doc) {
  const payload = await buildExport(doc);
  const filename = `works-full-${stamp()}.json`;
  const path = join(backupsDir(), filename);
  const data = JSON.stringify(payload);
  await ensureLayout();
  await writeFileAtomic(path, data);
  return {
    filename,
    path,
    bytes: Buffer.byteLength(data),
    cards: doc.cards.length,
    assets: Object.keys(payload.assets).length
  };
}
async function readBackupChunk(name, offset, length) {
  const file = backupFile(name);
  const info = await stat(file).catch(() => void 0);
  if (!info?.isFile()) throw Object.assign(new Error("\u5907\u4EFD\u4E0D\u5B58\u5728"), { statusCode: 404 });
  const start = Math.max(0, Math.min(Math.floor(offset) || 0, Math.max(0, info.size - 1)));
  const size = Math.max(1, Math.min(Math.floor(length) || 0, 8 * 1024 * 1024));
  const end = Math.min(start + size, info.size);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(end - start);
    if (buffer.length) await handle.read(buffer, 0, buffer.length, start);
    return { data: buffer, total: info.size, offset: start, filename: name };
  } finally {
    await handle.close();
  }
}
async function importPayload(raw) {
  const input = raw ?? {};
  const isEnvelope = typeof input.format === "string" && input.format === EXPORT_FORMAT;
  const rawDoc = isEnvelope ? input.doc : input.doc ?? input;
  const doc = sanitizeDoc(rawDoc);
  const assets = isEnvelope ? input.assets : void 0;
  let written = 0;
  if (assets && typeof assets === "object") {
    await ensureLayout();
    for (const [assetId, value] of Object.entries(assets)) {
      if (!ASSET_ID.test(assetId) || typeof value?.data !== "string") continue;
      const existing = await readAsset(assetId);
      if (existing) continue;
      await putAsset(value.data, typeof value.mime === "string" ? value.mime : "");
      written += 1;
    }
    await refreshAssetIndex();
  }
  const before = await readDoc();
  await maybeSnapshot(before, true);
  const stored = await replaceDoc(doc);
  return { cards: stored.cards.length, tags: stored.tags.length, assets: written, restoredFrom: isEnvelope ? "full" : "document" };
}
async function restoreBackup(name) {
  const file = backupFile(name);
  const text2 = await readFile(file, "utf8").catch(() => {
    throw Object.assign(new Error("\u5907\u4EFD\u65E0\u6CD5\u8BFB\u53D6"), { statusCode: 404 });
  });
  let parsed;
  try {
    parsed = JSON.parse(text2);
  } catch {
    throw Object.assign(new Error("\u5907\u4EFD\u4E0D\u662F\u6709\u6548 JSON"), { statusCode: 400 });
  }
  return importPayload(parsed);
}
async function restoreByName(name) {
  if (name.startsWith("works-full-")) return restoreBackup(name);
  const file = backupFile(name);
  const parsed = JSON.parse(await readFile(file, "utf8").catch(() => {
    throw Object.assign(new Error("\u5907\u4EFD\u65E0\u6CD5\u8BFB\u53D6"), { statusCode: 404 });
  }));
  const doc = sanitizeDoc(parsed?.doc ?? parsed);
  const before = await readDoc();
  await maybeSnapshot(before, true);
  const stored = await replaceDoc(doc);
  return { cards: stored.cards.length, tags: stored.tags.length, assets: 0, restoredFrom: "document" };
}
export {
  DOC_VERSION,
  EXPORT_FORMAT,
  assetFile,
  assetList,
  assetsDir,
  backupsDir,
  buildExport,
  collectAssets,
  deleteBackup,
  docPath,
  dshHome,
  emptyDoc,
  ensureLayout,
  importPayload,
  listBackups,
  maybeSnapshot,
  putAsset,
  readAsset,
  readBackupChunk,
  readDoc,
  refreshAssetIndex,
  replaceDoc,
  restoreBackup,
  restoreByName,
  sanitizeDoc,
  saveDoc,
  serialize,
  snapshotDoc,
  worksRoot,
  writeExportFile,
  writeFileAtomic
};
//# sourceMappingURL=store.js.map
