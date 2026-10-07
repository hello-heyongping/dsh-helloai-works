/**
 * dsh-helloai-works — Host-side store.
 *
 * Everything lives in one folder under DSH_HOME so the collection is a plain
 * filesystem artefact a person can copy, sync or inspect without this plugin:
 *
 *   <DSH_HOME>/helloai-works/
 *     works.json          the document: tags + cards (no image bytes inside)
 *     assets/<sha1>.<ext> one file per collected image, content-addressed
 *     backups/            rotating snapshots + self-contained full exports
 *
 * Images are deliberately *not* inlined into the document: the page stays small
 * and fast, the browser caches the bytes as ordinary images, and the document
 * never has to be re-serialised because a picture was added.
 */
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

export type BlockKind = "text" | "image";

export interface TextBlock {
  id: string;
  kind: "text";
  text: string;
}

export interface ImageBlock {
  id: string;
  kind: "image";
  /** Asset id (sha1 hex of the bytes) — resolves to `assets/<id>.<ext>`. */
  asset: string;
  caption: string;
}

export type WorkBlock = TextBlock | ImageBlock;

export interface WorkCard {
  id: string;
  title: string;
  /** Tag ids; unknown ids are dropped while sanitising. */
  tags: string[];
  /** Where the material came from — a URL, a book title, anything. */
  source: string;
  blocks: WorkBlock[];
  /** When the material was collected; shown in the list. */
  createdAt: string;
  updatedAt: string;
}

export interface WorkTag {
  id: string;
  name: string;
}

export interface WorkDoc {
  version: number;
  /** Monotonic server-side counter; lets the page notice an out-of-band write. */
  revision: number;
  updatedAt: string;
  tags: WorkTag[];
  cards: WorkCard[];
}

export interface AssetInfo {
  id: string;
  ext: string;
  mime: string;
  bytes: number;
  modifiedAt: string;
}

export interface BackupRecord {
  name: string;
  kind: "snapshot" | "full";
  bytes: number;
  modifiedAt: string;
}

export interface ExportResult {
  filename: string;
  path: string;
  bytes: number;
  cards: number;
  assets: number;
}

export interface ImportResult {
  cards: number;
  tags: number;
  assets: number;
  restoredFrom: string;
}

export const DOC_VERSION = 1;
export const EXPORT_FORMAT = "dsh-helloai-works";
/** Automatic snapshots are cheap (document only); full exports are self-contained. */
const SNAPSHOT_LIMIT = 30;
/** At most one automatic snapshot per window, however often autosave fires. */
const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
/** Per-image ceiling after the page has already downscaled: 32 MB of base64. */
const MAX_ASSET_BASE64 = 32 * 1024 * 1024;
const MAX_CARDS = 20_000;
const MAX_BLOCKS = 2_000;
const MAX_TEXT = 200_000;
const MAX_TITLE = 400;
const MAX_TAG_NAME = 80;
const MAX_SOURCE = 2_000;

const ASSET_ID = /^[a-f0-9]{40}$/;
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

export function dshHome(): string {
  return resolve(process.env.DSH_HOME || join(homedir(), ".dsh"));
}

export function worksRoot(): string {
  return join(dshHome(), "helloai-works");
}

export function docPath(): string {
  return join(worksRoot(), "works.json");
}

export function assetsDir(): string {
  return join(worksRoot(), "assets");
}

export function backupsDir(): string {
  return join(worksRoot(), "backups");
}

export async function ensureLayout(): Promise<void> {
  await mkdir(assetsDir(), { recursive: true });
  await mkdir(backupsDir(), { recursive: true });
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function nowIso(): string {
  return new Date().toISOString();
}

/** `20261002-144355` — local time, because a person reads the file names. */
function stamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function text(value: unknown, limit: number, fallback = ""): string {
  return typeof value === "string" ? value.slice(0, limit) : fallback;
}

function isoOrNow(value: unknown): string {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return nowIso();
}

/**
 * Keep the caller's id when it is a plain token, and mint one otherwise.
 *
 * Ids are stable identities: regenerating them would churn React keys on every
 * reload and make an unchanged document look changed to the save guard. Only the
 * *shape* is checked here — asset ids, the one value that becomes a file name,
 * are validated against their own sha1 pattern before touching the filesystem.
 */
function id(value: unknown): string {
  if (typeof value === "string" && value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value)) return value;
  return randomUUID().replace(/-/g, "").slice(0, 24);
}

export function emptyDoc(): WorkDoc {
  return { version: DOC_VERSION, revision: 1, updatedAt: nowIso(), tags: [], cards: [] };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * One writer at a time. The HTTP surface can receive two saves in the same tick
 * (a debounced autosave racing a manual one); serialising them keeps the
 * read-modify-write of the revision counter honest.
 */
let queue: Promise<unknown> = Promise.resolve();
export function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Durable replace: write a sibling temp file, flush it to disk, then rename.
 * A crash mid-write leaves the previous document untouched.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const temp = `${path}.tmp-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temp, "w");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Sanitising — the client is never trusted with the shape of the document
 * ------------------------------------------------------------------ */

export function sanitizeDoc(raw: unknown): WorkDoc {
  const input = (raw ?? {}) as Record<string, unknown>;

  const tags: WorkTag[] = [];
  const seenTag = new Set<string>();
  for (const item of Array.isArray(input.tags) ? input.tags : []) {
    const candidate = (item ?? {}) as Record<string, unknown>;
    const tagId = id(candidate.id);
    const tagName = text(candidate.name, MAX_TAG_NAME).trim();
    if (!tagName || seenTag.has(tagId)) continue;
    seenTag.add(tagId);
    tags.push({ id: tagId, name: tagName });
  }

  const cards: WorkCard[] = [];
  const seenCard = new Set<string>();
  for (const item of (Array.isArray(input.cards) ? input.cards : []).slice(0, MAX_CARDS)) {
    const candidate = (item ?? {}) as Record<string, unknown>;
    const cardId = id(candidate.id);
    if (seenCard.has(cardId)) continue;
    seenCard.add(cardId);

    const blocks: WorkBlock[] = [];
    for (const block of (Array.isArray(candidate.blocks) ? candidate.blocks : []).slice(0, MAX_BLOCKS)) {
      const entry = (block ?? {}) as Record<string, unknown>;
      const blockId = id(entry.id);
      if (entry.kind === "image") {
        const asset = text(entry.asset, 64);
        if (!ASSET_ID.test(asset)) continue;
        blocks.push({ id: blockId, kind: "image", asset, caption: text(entry.caption, MAX_TEXT) });
      } else {
        const body = text(entry.text, MAX_TEXT);
        // An empty text block is still meaningful while editing, so it survives.
        blocks.push({ id: blockId, kind: "text", text: body });
      }
    }

    const cardTags = (Array.isArray(candidate.tags) ? candidate.tags : [])
      .map((value) => (typeof value === "string" ? value : ""))
      .filter((value) => value && seenTag.has(value));

    cards.push({
      id: cardId,
      title: text(candidate.title, MAX_TITLE),
      tags: [...new Set(cardTags)],
      source: text(candidate.source, MAX_SOURCE),
      blocks,
      createdAt: isoOrNow(candidate.createdAt),
      updatedAt: isoOrNow(candidate.updatedAt),
    });
  }

  return {
    version: DOC_VERSION,
    revision: Number.isFinite(input.revision) ? Math.max(1, Math.floor(Number(input.revision))) : 1,
    updatedAt: isoOrNow(input.updatedAt),
    tags,
    cards,
  };
}

/* ------------------------------------------------------------------ *
 * Document
 * ------------------------------------------------------------------ */

export async function readDoc(): Promise<WorkDoc> {
  await ensureLayout();
  try {
    const parsed = JSON.parse(await readFile(docPath(), "utf8"));
    const doc = sanitizeDoc(parsed);
    // `revision` is ours, not the client's: it counts writes on this machine.
    doc.revision = Number.isFinite(parsed?.revision) ? Math.max(1, Math.floor(parsed.revision)) : 1;
    return doc;
  } catch {
    return emptyDoc();
  }
}

export interface SaveOutcome {
  /** False when the caller's `baseRevision` no longer matches the stored one. */
  ok: boolean;
  doc: WorkDoc;
}

/** The parts a save may change; `revision` and `updatedAt` are ours to own. */
function sameContent(a: WorkDoc, b: WorkDoc): boolean {
  return JSON.stringify({ tags: a.tags, cards: a.cards }) === JSON.stringify({ tags: b.tags, cards: b.cards });
}

/**
 * Persist a document the page edited.
 *
 * `baseRevision` is the optimistically checked version the caller last saw: two
 * windows editing one collection would otherwise silently clobber each other.
 * Passing it is optional so plain HTTP clients (curl, tests) stay usable.
 *
 * @param raw - the page's document, sanitised before it is trusted.
 * @param baseRevision - the revision the caller read before editing.
 * @returns the stored document, or the current one when the revision has moved.
 */
export async function saveDoc(raw: unknown, baseRevision?: number): Promise<SaveOutcome> {
  return serialize(async () => {
    await ensureLayout();
    const current = await readDoc();
    if (typeof baseRevision === "number" && Number.isFinite(baseRevision) && baseRevision !== current.revision) {
      return { ok: false, doc: current };
    }

    const doc = sanitizeDoc(raw);
    // Nothing actually changed (only a timestamp drifted, or a duplicate save
    // arrived): keep the stored revision and skip the whole-file rewrite.
    if (sameContent(current, doc)) return { ok: true, doc: current };

    doc.revision = current.revision + 1;
    doc.updatedAt = nowIso();
    // Snapshot what is being replaced, so a bad edit is recoverable.
    await maybeSnapshot(current).catch(() => undefined);
    await writeFileAtomic(docPath(), JSON.stringify(doc));
    return { ok: true, doc };
  });
}

/** Replace the document wholesale (import / backup restore). */
export async function replaceDoc(doc: WorkDoc): Promise<WorkDoc> {
  return serialize(async () => {
    await ensureLayout();
    const current = await readDoc();
    doc.revision = current.revision + 1;
    doc.updatedAt = nowIso();
    await writeFileAtomic(docPath(), JSON.stringify(doc));
    return doc;
  });
}

/* ------------------------------------------------------------------ *
 * Assets
 * ------------------------------------------------------------------ */

function sha1(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}

let assetIndex: Map<string, AssetInfo> | undefined;

/** Rebuild the id → file index by reading the assets directory. */
export async function refreshAssetIndex(): Promise<Map<string, AssetInfo>> {
  await mkdir(assetsDir(), { recursive: true });
  const index = new Map<string, AssetInfo>();
  for (const entry of await readdir(assetsDir(), { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot <= 0) continue;
    const assetId = entry.name.slice(0, dot);
    const ext = entry.name.slice(dot + 1).toLowerCase();
    const mime = EXT_MIME[ext];
    if (!mime || !ASSET_ID.test(assetId)) continue;
    const info = await stat(join(assetsDir(), entry.name)).catch(() => undefined);
    if (!info?.isFile()) continue;
    index.set(assetId, { id: assetId, ext, mime, bytes: info.size, modifiedAt: info.mtime.toISOString() });
  }
  assetIndex = index;
  return index;
}

export async function assetList(): Promise<AssetInfo[]> {
  const index = assetIndex ?? (await refreshAssetIndex());
  return [...index.values()].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

export function assetFile(info: Pick<AssetInfo, "id" | "ext">): string {
  return join(assetsDir(), `${info.id}.${info.ext}`);
}

/**
 * Store one image. Content addressing means the same picture pasted twice
 * costs one file, and the caller may safely keep both references.
 */
export async function putAsset(dataBase64: string, declaredMime: string): Promise<AssetInfo> {
  const payload = dataBase64.includes(",") ? dataBase64.slice(dataBase64.indexOf(",") + 1) : dataBase64;
  if (payload.length > MAX_ASSET_BASE64) throw Object.assign(new Error("图片过大"), { statusCode: 413 });
  const bytes = Buffer.from(payload, "base64");
  if (bytes.byteLength === 0) throw Object.assign(new Error("图片内容为空"), { statusCode: 400 });

  const mime = MIME_EXT[declaredMime] ? declaredMime : sniffMime(bytes);
  const ext = MIME_EXT[mime];
  if (!ext) throw Object.assign(new Error(`不支持的图片格式：${declaredMime || "未知"}`), { statusCode: 415 });

  await mkdir(assetsDir(), { recursive: true });
  const assetId = sha1(bytes);
  const target = join(assetsDir(), `${assetId}.${ext}`);
  if (!(await exists(target))) await writeFileAtomic(target, bytes);
  const info: AssetInfo = { id: assetId, ext, mime, bytes: bytes.byteLength, modifiedAt: nowIso() };
  if (assetIndex) assetIndex.set(assetId, info);
  return info;
}

/** Trust the bytes when the browser did not declare a type we recognise. */
function sniffMime(bytes: Buffer): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length > 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length > 12 && bytes.subarray(4, 12).toString("ascii").startsWith("ftypavif")) return "image/avif";
  if (bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return "";
}

export async function readAsset(assetId: string): Promise<{ info: AssetInfo; bytes: Buffer } | undefined> {
  if (!ASSET_ID.test(assetId)) return undefined;
  const index = assetIndex ?? (await refreshAssetIndex());
  const info = index.get(assetId);
  if (!info) return undefined;
  try {
    return { info, bytes: await readFile(assetFile(info)) };
  } catch {
    assetIndex?.delete(assetId);
    return undefined;
  }
}

/**
 * Drop assets no block references any more. Snapshots are document-only, so
 * this can invalidate an old snapshot's pictures — say so in the UI.
 */
export async function collectAssets(doc: WorkDoc): Promise<{ removed: number; bytes: number; kept: number }> {
  return serialize(async () => {
    const referenced = new Set<string>();
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

/* ------------------------------------------------------------------ *
 * Backups
 * ------------------------------------------------------------------ */

const SNAPSHOT_NAME = /^works-\d{8}-\d{6}\.json$/;

/** Rotate automatic snapshots only; a full export is a deliberate artefact. */
async function rotateSnapshots(): Promise<void> {
  const entries = (await readdir(backupsDir())).filter((name) => SNAPSHOT_NAME.test(name)).sort();
  const stale = entries.slice(0, Math.max(0, entries.length - SNAPSHOT_LIMIT));
  for (const name of stale) await rm(join(backupsDir(), name), { force: true });
}

/** Never let two snapshots in the same second overwrite each other. */
async function freeSnapshotName(): Promise<string> {
  for (let step = 0; step < 120; step += 1) {
    const name = `works-${stamp(new Date(Date.now() + step * 1000))}.json`;
    if (!(await exists(join(backupsDir(), name)))) return name;
  }
  return `works-${stamp()}.json`;
}

/** A document-only snapshot: the whole card collection, none of the image bytes. */
export async function snapshotDoc(doc: WorkDoc): Promise<string> {
  await ensureLayout();
  const name = await freeSnapshotName();
  await writeFileAtomic(join(backupsDir(), name), JSON.stringify({ [EXPORT_FORMAT]: true, kind: "snapshot", savedAt: nowIso(), doc }, null, 0));
  await rotateSnapshots();
  return name;
}

/**
 * Autosave fires every time typing settles, so an unconditional snapshot would
 * write the document dozens of times a minute. One per window is enough: it caps
 * how much work a bad edit can destroy, and destructive actions snapshot
 * explicitly regardless.
 */
let lastSnapshotAt = 0;
export async function maybeSnapshot(doc: WorkDoc, force = false): Promise<string | undefined> {
  const now = Date.now();
  if (!force && now - lastSnapshotAt < SNAPSHOT_INTERVAL_MS) return undefined;
  const name = await snapshotDoc(doc);
  lastSnapshotAt = now;
  return name;
}

export async function listBackups(): Promise<{ directory: string; records: BackupRecord[] }> {
  await ensureLayout();
  const records: BackupRecord[] = [];
  for (const name of await readdir(backupsDir())) {
    if (!name.endsWith(".json")) continue;
    const info = await stat(join(backupsDir(), name)).catch(() => undefined);
    if (!info?.isFile()) continue;
    records.push({
      name,
      kind: name.startsWith("works-full-") ? "full" : "snapshot",
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    });
  }
  records.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || b.name.localeCompare(a.name));
  return { directory: backupsDir(), records };
}

/** Refuse anything that is not a plain file name inside the backups folder. */
function backupFile(name: string): string {
  if (!/^works-(full-)?\d{8}-\d{6}\.json$/.test(name)) {
    throw Object.assign(new Error("备份文件名不合法"), { statusCode: 400 });
  }
  return join(backupsDir(), name);
}

export async function deleteBackup(name: string): Promise<{ deleted: string }> {
  const file = backupFile(name);
  if (!(await exists(file))) throw Object.assign(new Error("备份不存在"), { statusCode: 404 });
  await rm(file, { force: true });
  return { deleted: name };
}

export interface ExportPayload {
  format: string;
  version: number;
  exportedAt: string;
  doc: WorkDoc;
  assets: Record<string, { mime: string; data: string }>;
}

/** A self-contained payload: document plus every image it references. */
export async function buildExport(doc: WorkDoc): Promise<ExportPayload> {
  const referenced = new Set<string>();
  for (const card of doc.cards) {
    for (const block of card.blocks) if (block.kind === "image") referenced.add(block.asset);
  }
  const assets: Record<string, { mime: string; data: string }> = {};
  for (const assetId of referenced) {
    const found = await readAsset(assetId);
    if (found) assets[assetId] = { mime: found.info.mime, data: found.bytes.toString("base64") };
  }
  return { format: EXPORT_FORMAT, version: DOC_VERSION, exportedAt: nowIso(), doc, assets };
}

/**
 * Write a self-contained export into `backups/` and hand back its coordinates.
 * The page downloads it separately, in chunks the desktop protocol can carry.
 */
export async function writeExportFile(doc: WorkDoc): Promise<ExportResult> {
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
    assets: Object.keys(payload.assets).length,
  };
}

export async function readBackupChunk(
  name: string,
  offset: number,
  length: number,
): Promise<{ data: Buffer; total: number; offset: number; filename: string }> {
  const file = backupFile(name);
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw Object.assign(new Error("备份不存在"), { statusCode: 404 });
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

/**
 * Accept a payload produced by `buildExport` (or a bare document, which older
 * hand-made files may be). Assets already on disk win; missing ones are written.
 */
export async function importPayload(raw: unknown): Promise<ImportResult> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const isEnvelope = typeof input.format === "string" && input.format === EXPORT_FORMAT;
  const rawDoc = isEnvelope ? input.doc : input.doc ?? input;
  const doc = sanitizeDoc(rawDoc);

  const assets = (isEnvelope ? input.assets : undefined) as Record<string, { mime?: string; data?: string }> | undefined;
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

/** Restore a snapshot or a full export that already sits in `backups/`. */
export async function restoreBackup(name: string): Promise<ImportResult> {
  const file = backupFile(name);
  const text = await readFile(file, "utf8").catch(() => {
    throw Object.assign(new Error("备份无法读取"), { statusCode: 404 });
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error("备份不是有效 JSON"), { statusCode: 400 });
  }
  // `importPayload` snapshots the current document before replacing it.
  return importPayload(parsed);
}

/** Restore any backup file, picking the right shape from its name. */
export async function restoreByName(name: string): Promise<ImportResult> {
  if (name.startsWith("works-full-")) return restoreBackup(name);
  const file = backupFile(name);
  const parsed = JSON.parse(await readFile(file, "utf8").catch(() => {
    throw Object.assign(new Error("备份无法读取"), { statusCode: 404 });
  }));
  const doc = sanitizeDoc((parsed as Record<string, unknown>)?.doc ?? parsed);
  const before = await readDoc();
  await maybeSnapshot(before, true);
  const stored = await replaceDoc(doc);
  return { cards: stored.cards.length, tags: stored.tags.length, assets: 0, restoredFrom: "document" };
}
