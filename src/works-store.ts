/**
 * dsh-helloai-works — shared client store.
 *
 * The main panel (tag rail + card list) and the right-Sidebar tab bodies are
 * separate React subtrees that cannot share context, yet both edit the same
 * collection. One module-level store with `useSyncExternalStore` keeps a single
 * document, a single autosave queue and a single notice between them.
 */
import * as React from "react";

export type Translate = (key: string, params?: Record<string, unknown>) => string;

export type TextBlock = { id: string; kind: "text"; text: string };
export type ImageBlock = { id: string; kind: "image"; asset: string; caption: string };
export type Block = TextBlock | ImageBlock;
export type Card = { id: string; title: string; tags: string[]; source: string; blocks: Block[]; createdAt: string; updatedAt: string };
export type Tag = { id: string; name: string };
export type Doc = { version: number; revision: number; updatedAt: string; tags: Tag[]; cards: Card[] };
export type BackupRecord = { name: string; kind: "snapshot" | "full"; bytes: number; modifiedAt: string };
/** `tone` styles a notice button; an untinted action stays plain. */
export type NoticeAction = { label: string; run: () => void; tone?: "primary" | "danger" };
/**
 * `follows` marks a notice the card column must render too, and — because it is
 * the only kind that carries an unresolved decision — one a confirmation may
 * never replace.
 */
export type Notice = { kind: "success" | "error" | "info"; text: string; actions?: NoticeAction[]; follows?: boolean };
export type SaveState = "idle" | "saving" | "saved" | "error";
/** The stored document moved under us; the page must choose a side. */
export type ConflictInfo = { revision: number; updatedAt: string; cards: number };
/**
 * One reply on its way into the collection, while the dialog still allows edits.
 *
 * Tags are held by name, not id: a name the collection does not know yet is a tag
 * the user is inventing, and turning it into a real tag is the save's job — so
 * cancelling the dialog never leaves a half-made tag behind.
 */
export type CollectDraft = { title: string; body: string; tags: string[]; newTag: string };

export const API = "/api/dsh-helloai-works";
/** Pseudo tag id for the "no tag yet" bucket. */
export const UNTAGGED = "__untagged__";

export interface WorksSnapshot {
  doc: Doc | null;
  assets: ReadonlySet<string>;
  loading: boolean;
  saving: SaveState;
  savedAt: string;
  notice: Notice | null;
  /** Non-null while unsaved local edits sit on top of a document that changed elsewhere. */
  conflict: ConflictInfo | null;
  /** The card the list highlights; the tab body may show an older one after a reload. */
  activeCardId: string | null;
  /** Set only when the right Sidebar refused the tab, so the panel can host the editor. */
  inlineCardId: string | null;
  /** Non-null while the "add this reply to the works" dialog is open. */
  collect: CollectDraft | null;
  root: string;
  docPath: string;
}

/* ------------------------------------------------------------------ *
 * Free helpers
 * ------------------------------------------------------------------ */

export function message(t: Translate, key: string, params: Record<string, unknown> = {}): string {
  let text = t(key, params);
  for (const [name, value] of Object.entries(params)) text = text.replace(`{${name}}`, String(value));
  return text;
}

export function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function formatTime(value?: string, withTime = true): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function excerpt(card: Card, limit = 96): string {
  for (const block of card.blocks) {
    if (block.kind !== "text") continue;
    const text = block.text.replace(/\s+/g, " ").trim();
    if (text) return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }
  const images = card.blocks.filter((block) => block.kind === "image").length;
  return images ? `${images} 🖼` : "";
}

export function imageCount(card: Card): number {
  return card.blocks.filter((block) => block.kind === "image").length;
}

/* ------------------------------------------------------------------ *
 * Reading the collection: index, filter, search
 *
 * The panel holds the whole document in memory, so the cost that grows with
 * the collection is per *keystroke* work, not per lookup I/O. These three
 * helpers keep that work linear and allocation-free: the lower-casing happens
 * once per document (not once per card per keystroke), the ordering happens
 * once per tag/sort change (not on every character typed), and the needle is
 * then a plain substring scan.
 * ------------------------------------------------------------------ */

/**
 * One lower-cased haystack per card, holding every field the search box reads:
 * title, source, each block's text or caption, and the names of its tags.
 *
 * Fields are joined with a newline, which an `<input>` can never contain, so a
 * needle still cannot match across the seam between two fields.
 */
export function buildSearchIndex(doc: Doc | null): Map<string, string> {
  const index = new Map<string, string>();
  const names = new Map((doc?.tags ?? []).map((tag) => [tag.id, tag.name]));
  for (const card of doc?.cards ?? []) {
    const parts = [card.title, card.source, ...card.tags.map((tagId) => names.get(tagId) ?? "")];
    for (const block of card.blocks) parts.push(block.kind === "text" ? block.text : block.caption);
    index.set(card.id, parts.join("\n").toLowerCase());
  }
  return index;
}

/**
 * The tag rail's selection and the list's order, applied once per change and
 * deliberately *without* the search needle — typing must not re-sort the list.
 */
export function selectCards(doc: Doc | null, options: { activeTag: string | null; sortDesc: boolean }): Card[] {
  const source = doc?.cards ?? [];
  const list = options.activeTag === UNTAGGED
    ? source.filter((card) => !card.tags.length)
    : options.activeTag
      ? source.filter((card) => card.tags.includes(options.activeTag as string))
      : source;
  return [...list].sort((a, b) => (options.sortDesc ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt)));
}

/** The search box: one substring test per card against the prebuilt index. */
export function searchCards(cards: Card[], query: string, index: ReadonlyMap<string, string>): Card[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return cards;
  return cards.filter((card) => index.get(card.id)?.includes(needle) ?? false);
}

export function assetUrl(assetId: string): string {
  return `${API}/asset/${encodeURIComponent(assetId)}`;
}

/**
 * A Host plugin reload drops in-flight requests, which the browser reports as
 * `TypeError: Failed to fetch`. Those are transient during development, so retry
 * briefly before telling the user something actionable.
 */
const RETRY_DELAYS = [400, 1200, 2500];
export async function request(t: Translate, url: string, init?: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (attempt < RETRY_DELAYS.length && response.status >= 502 && response.status <= 504) {
        await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAYS[attempt]));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt >= RETRY_DELAYS.length) throw new Error(t("networkFailed"));
      console.warn("[dsh-helloai-works] request failed, retrying", url, error);
      await new Promise((resolve) => window.setTimeout(resolve, RETRY_DELAYS[attempt]));
    }
  }
}

export async function readJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

/** Width budget for a collected picture: anything wider is scaled down to this. */
export const MAX_IMAGE_WIDTH = 1500;
/** Quality for the lossy formats — the ones with no transparency to protect. */
const LOSSY_QUALITY = 0.88;
/** Formats canvas can safely re-encode; GIF and SVG keep their original bytes. */
const REENCODABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/avif", "image/bmp"]);
/**
 * Formats that own an alpha channel: a JPEG round-trip would flatten it onto
 * black, so these are re-encoded in their own format instead.
 */
const ALPHA_SAFE = new Set(["image/png", "image/webp"]);

export type ImagePlan = {
  /** Multiplier for both edges; 1 means the picture is already inside the budget. */
  scale: number;
  /** False when the original bytes should travel untouched. */
  reencode: boolean;
  /** The format to encode with when `reencode` is true. */
  mime: string;
};

/**
 * The insert policy for one picture, with the measuring left to the caller.
 *
 * A card is a record, not a photo library: the width is capped at 1500 px and
 * anything wider is scaled proportionally — a 6000 px camera frame or a 4K
 * screenshot becomes 1500 px wide without distorting the aspect ratio. A
 * picture already inside the budget keeps its exact bytes, because re-encoding
 * it would only cost quality for nothing.
 *
 * When a scale *is* needed, PNG and WebP stay in their own format so their
 * transparency survives; JPEG, BMP and AVIF become JPEG. GIF and SVG are never
 * re-encoded — animation and vectors do not survive a canvas round-trip.
 */
export function planImage(input: { width: number; mime: string }): ImagePlan {
  const mime = input.mime || "image/png";
  if (!REENCODABLE.has(mime)) return { scale: 1, reencode: false, mime };
  const scale = input.width > MAX_IMAGE_WIDTH ? MAX_IMAGE_WIDTH / input.width : 1;
  if (scale >= 1) return { scale: 1, reencode: false, mime };
  return { scale, reencode: true, mime: ALPHA_SAFE.has(mime) ? mime : "image/jpeg" };
}

/**
 * Prepare one picture for the Host: measure it, ask `planImage`, and only touch
 * the pixels when the plan says to. Downscaling happens here rather than on the
 * Host because the browser already has the decoded frame.
 */
export async function prepareImage(file: File): Promise<{ data: string; mime: string }> {
  const mime = file.type || "image/png";
  const original = async (): Promise<{ data: string; mime: string }> => ({ data: await toBase64(file), mime });
  if (!REENCODABLE.has(mime)) return original();
  try {
    const bitmap = await createImageBitmap(file);
    const plan = planImage({ width: bitmap.width, mime });
    if (!plan.reencode) {
      bitmap.close?.();
      return original();
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * plan.scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * plan.scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    // PNG takes no quality argument; the lossy formats do.
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, plan.mime, plan.mime === "image/png" ? undefined : LOSSY_QUALITY),
    );
    if (!blob) throw new Error("encode failed");
    return { data: await toBase64(blob), mime: blob.type || plan.mime };
  } catch {
    // A decode or encode failure still lets the original through; the Host caps size.
    return original();
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

const EMPTY: ReadonlySet<string> = new Set();

class WorksStore {
  private snapshot: WorksSnapshot = {
    doc: null,
    assets: EMPTY,
    loading: true,
    saving: "idle",
    savedAt: "",
    notice: null,
    conflict: null,
    activeCardId: null,
    inlineCardId: null,
    collect: null,
    root: "",
    docPath: "",
  };

  private listeners = new Set<() => void>();
  private pending: Doc | null = null;
  private timer: number | undefined;
  private savedSerialized = "";
  private started = false;
  /** The stored revision this page's edits are based on (optimistic lock). */
  private baseRevision = 0;
  private conflict: ConflictInfo | null = null;
  private t: Translate = (key) => key;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): WorksSnapshot => this.snapshot;

  /** Keep the latest namespace-bound translate for background work (timers, uploads). */
  setTranslate = (t: Translate): void => {
    this.t = t;
  };

  private emit(patch: Partial<WorksSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  card(cardId: string | null | undefined): Card | null {
    if (!cardId) return null;
    return this.snapshot.doc?.cards.find((item) => item.id === cardId) ?? null;
  }

  tagName(tagId: string): string {
    return this.snapshot.doc?.tags.find((tag) => tag.id === tagId)?.name ?? "";
  }

  setNotice = (notice: Notice | null): void => this.emit({ notice });

  /**
   * Ask before something irreversible — without ever blocking the renderer.
   *
   * `window.confirm` is a synchronous native modal: the desktop shell shows it
   * from the main process while the page waits, so a dialog that fails to appear
   * (an unfocused or occluded window is the usual cause) leaves the renderer
   * blocked forever and every input in the app dead until a restart. A
   * confirmation is therefore just a notice whose buttons are "do it" and
   * "cancel" — the same shape the save conflict already uses.
   *
   * A notice marked `follows` is left alone: it holds an unresolved conflict,
   * and replacing it would strand the edits it protects with nowhere to go.
   */
  confirmDestructive(options: { text: string; confirmLabel: string; cancelLabel: string; run: () => void }): void {
    const current = this.snapshot.notice;
    if (current?.actions?.length && current.follows) return;
    this.setNotice({
      kind: "error",
      text: options.text,
      actions: [
        { label: options.cancelLabel, run: () => this.setNotice(null) },
        {
          label: options.confirmLabel,
          tone: "danger",
          run: () => {
            this.setNotice(null);
            options.run();
          },
        },
      ],
    });
  }

  setActiveCard = (cardId: string | null): void => this.emit({ activeCardId: cardId, inlineCardId: cardId ? this.snapshot.inlineCardId : null });

  setInlineCard = (cardId: string | null): void => this.emit({ inlineCardId: cardId });

  /* ---------------- collecting a reply ---------------- */

  /**
   * Open the draft dialog on one reply.
   *
   * The dialog is reachable from the conversation, which may be the first thing
   * the user touches in a session, so this is what loads the document: by the
   * time a person has read the draft and pressed save, it is there.
   */
  openCollect = (draft: { title: string; body: string }): void => {
    this.start();
    this.emit({ collect: { title: draft.title, body: draft.body, tags: [], newTag: "" } });
  };

  patchCollect = (patch: Partial<CollectDraft>): void => {
    const current = this.snapshot.collect;
    if (!current) return;
    this.emit({ collect: { ...current, ...patch } });
  };

  closeCollect = (): void => this.emit({ collect: null });

  /**
   * Turn the draft into the newest card and push it to the Host.
   *
   * @returns the name to announce, or null when the document has not arrived yet
   * (the dialog says so and keeps the draft, so nothing typed is lost).
   */
  saveCollect = (): string | null => {
    const draft = this.snapshot.collect;
    if (!draft || !this.snapshot.doc) {
      // The first load may have failed (a host reload drops it); the user asking
      // again is the right moment to retry, so the dialog is not a dead end.
      void this.reload();
      return null;
    }
    const now = new Date().toISOString();
    const id = newId();
    const title = draft.title.trim().slice(0, 400);
    const body = draft.body;
    // A name still sitting in the input is meant, not abandoned, so fold it in.
    const wanted = [...draft.tags, draft.newTag].map((name) => name.trim()).filter(Boolean);
    // Card and tags land in one edit: an existing name is reused, a new one is
    // minted here — and because this only runs on confirm, a cancelled dialog
    // writes nothing at all.
    this.mutate((current) => {
      const tags = [...current.tags];
      const tagIds: string[] = [];
      for (const name of wanted) {
        const lower = name.toLowerCase();
        let tag = tags.find((item) => item.name.toLowerCase() === lower);
        if (!tag) {
          tag = { id: newId(), name: name.slice(0, 80) };
          tags.push(tag);
        }
        if (!tagIds.includes(tag.id)) tagIds.push(tag.id);
      }
      const card: Card = {
        id,
        title,
        tags: tagIds,
        source: "",
        blocks: [{ id: newId(), kind: "text", text: body }],
        createdAt: now,
        updatedAt: now,
      };
      return { ...current, tags, cards: [card, ...current.cards] };
    });
    this.emit({ collect: null, activeCardId: id });
    // The user confirmed, so this is not a debounced edit: send it now.
    void this.flush();
    return title || this.t("untitled");
  };

  /** Load once; every surface may call this during its own effect. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.reload();
  }

  reload = async (): Promise<void> => {
    try {
      const body = await readJson(await request(this.t, `${API}/state`));
      const doc = body.doc as Doc;
      this.pending = null;
      this.savedSerialized = JSON.stringify(doc);
      this.baseRevision = Number(body.revision || doc.revision || 0);
      this.conflict = null;
      this.emit({
        doc,
        assets: new Set(Array.isArray(body.assets) ? (body.assets as string[]) : []),
        loading: false,
        saving: "idle",
        conflict: null,
        root: String(body.root || ""),
        docPath: String(body.docPath || ""),
      });
    } catch (error) {
      this.emit({ loading: false, notice: { kind: "error", text: `${this.t("loadFailed")}: ${errorText(error)}` } });
    }
  };

  /** Apply an edit locally, then autosave once typing settles. */
  mutate = (updater: (doc: Doc) => Doc): void => {
    const current = this.snapshot.doc;
    if (!current) return;
    const next = updater(current);
    this.snapshot = { ...this.snapshot, doc: next };
    this.pending = next;
    for (const listener of this.listeners) listener();
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 800);
  };

  /**
   * Push whatever is pending; the debounce, the Save button and export share it.
   *
   * Sends the revision this page's edits are based on. When the Host answers 409
   * the local document is kept — nothing is lost — and the page is asked to
   * decide between its own changes and the stored ones.
   */
  flush = async (): Promise<void> => {
    const next = this.pending;
    if (!next) return;
    if (this.conflict) return; // Unresolved conflict: keep the edits, stop retrying.
    const serialized = JSON.stringify(next);
    if (serialized === this.savedSerialized) {
      this.pending = null;
      return;
    }
    this.pending = null;
    this.emit({ saving: "saving" });
    try {
      const response = await request(this.t, `${API}/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc: next, baseRevision: this.baseRevision }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.status === 409) {
        this.raiseConflict(body, next);
        return;
      }
      if (!response.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${response.status}`);
      this.savedSerialized = serialized;
      this.baseRevision = Number(body.revision || this.baseRevision);
      this.emit({ saving: "saved", savedAt: String(body.updatedAt || ""), conflict: null });
    } catch (error) {
      // Keep the pending document so the next edit, or the Save button, retries.
      this.pending = next;
      this.emit({ saving: "error", notice: { kind: "error", text: `${this.t("saveFailed")}: ${errorText(error)}` } });
    }
  };

  private raiseConflict(body: any, local: Doc): void {
    this.conflict = {
      revision: Number(body?.revision || 0),
      updatedAt: String(body?.updatedAt || ""),
      cards: Number(body?.cards || 0),
    };
    this.pending = local;
    this.emit({
      saving: "error",
      conflict: this.conflict,
      notice: {
        kind: "error",
        // A decision the user has to make: it follows them into the card column,
        // and no later confirmation is allowed to replace it.
        follows: true,
        text: message(this.t, "conflictText", {
          cards: this.conflict.cards,
          revision: this.conflict.revision,
          time: formatTime(this.conflict.updatedAt),
        }),
        actions: [
          { label: this.t("conflictKeepMine"), tone: "primary", run: () => void this.keepMine() },
          { label: this.t("conflictTakeTheirs"), run: () => void this.takeTheirs() },
        ],
      },
    });
  }

  /** Accept the stored revision as the new base and push the local edits over it. */
  keepMine = async (): Promise<void> => {
    if (!this.conflict) return;
    this.baseRevision = this.conflict.revision;
    this.conflict = null;
    this.emit({ conflict: null, notice: null });
    await this.flush();
    if (!this.conflict) this.setNotice({ kind: "success", text: this.t("conflictKeptMine") });
  };

  /** Drop the local edits and adopt the stored document. */
  takeTheirs = async (): Promise<void> => {
    this.conflict = null;
    this.pending = null;
    this.emit({ conflict: null, notice: null });
    await this.reload();
    this.setNotice({ kind: "success", text: this.t("conflictTookTheirs") });
  };

  private scheduleIdleFlush(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 800);
  }

  /* ---------------- tags ---------------- */

  addTag = (rawName: string, cardId?: string): string | undefined => {
    const name = rawName.trim().slice(0, 80);
    if (!name) return undefined;
    const existing = this.snapshot.doc?.tags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
    const tagId = existing?.id ?? newId();
    this.mutate((current) => ({
      ...current,
      tags: existing ? current.tags : [...current.tags, { id: tagId, name }],
      cards: cardId
        ? current.cards.map((item) => (item.id === cardId && !item.tags.includes(tagId) ? { ...item, tags: [...item.tags, tagId] } : item))
        : current.cards,
    }));
    return tagId;
  };

  /**
   * Rename a tag.
   *
   * Renaming onto a name that already exists **merges** the two rather than
   * leaving two tags with one name: the cards move across and the old tag goes
   * away. That is what someone typing an existing name means either way, and it
   * is the only way to fold a mistyped tag into the right one.
   *
   * @returns what happened, so the caller can say so.
   */
  renameTag = (tagId: string, rawName: string): "renamed" | "merged" | "empty" | "unchanged" => {
    const name = rawName.trim().slice(0, 80);
    if (!name) return "empty";
    const doc = this.snapshot.doc;
    const tag = doc?.tags.find((item) => item.id === tagId);
    if (!doc || !tag) return "unchanged";
    if (tag.name === name) return "unchanged";
    const target = doc.tags.find((item) => item.id !== tagId && item.name.toLowerCase() === name.toLowerCase());
    if (!target) {
      this.mutate((current) => ({ ...current, tags: current.tags.map((item) => (item.id === tagId ? { ...item, name } : item)) }));
      return "renamed";
    }
    this.mutate((current) => ({
      ...current,
      tags: current.tags.filter((item) => item.id !== tagId),
      cards: current.cards.map((item) => (item.tags.includes(tagId) ? { ...item, tags: [...new Set(item.tags.map((value) => (value === tagId ? target.id : value)))] } : item)),
    }));
    return "merged";
  };

  deleteTag = (tagId: string): void => {
    this.mutate((current) => ({
      ...current,
      tags: current.tags.filter((tag) => tag.id !== tagId),
      cards: current.cards.map((item) => (item.tags.includes(tagId) ? { ...item, tags: item.tags.filter((value) => value !== tagId) } : item)),
    }));
  };

  /* ---------------- cards ---------------- */

  createCard = (tagId?: string | null): string => {
    const now = new Date().toISOString();
    const id = newId();
    const tags = tagId && tagId !== UNTAGGED ? [tagId] : [];
    this.mutate((current) => ({
      ...current,
      cards: [{ id, title: "", tags, source: "", blocks: [{ id: newId(), kind: "text", text: "" }], createdAt: now, updatedAt: now }, ...current.cards],
    }));
    this.setActiveCard(id);
    return id;
  };

  updateCard = (cardId: string, patch: Partial<Card>): void => {
    this.mutate((current) => ({
      ...current,
      cards: current.cards.map((item) => (item.id === cardId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item)),
    }));
  };

  /** Copy a card in place, directly after the original, with fresh block ids. */
  duplicateCard = (cardId: string, titleSuffix = ""): string | undefined => {
    const source = this.snapshot.doc?.cards.find((item) => item.id === cardId);
    if (!source) return undefined;
    const now = new Date().toISOString();
    const id = newId();
    const copy: Card = {
      ...source,
      id,
      title: source.title ? `${source.title}${titleSuffix}` : "",
      // Fresh ids: two cards must never share a block identity.
      blocks: source.blocks.map((block) => ({ ...block, id: newId() })),
      createdAt: now,
      updatedAt: now,
    };
    this.mutate((current) => {
      const index = current.cards.findIndex((item) => item.id === cardId);
      const cards = [...current.cards];
      cards.splice(index < 0 ? 0 : index + 1, 0, copy);
      return { ...current, cards };
    });
    this.setActiveCard(id);
    return id;
  };

  deleteCard = (cardId: string): void => {
    this.mutate((current) => ({ ...current, cards: current.cards.filter((item) => item.id !== cardId) }));
    this.emit({ activeCardId: this.snapshot.activeCardId === cardId ? null : this.snapshot.activeCardId, inlineCardId: this.snapshot.inlineCardId === cardId ? null : this.snapshot.inlineCardId });
  };

  toggleCardTag = (cardId: string, tagId: string): void => {
    this.mutate((current) => ({
      ...current,
      cards: current.cards.map((item) => {
        if (item.id !== cardId) return item;
        const has = item.tags.includes(tagId);
        return { ...item, tags: has ? item.tags.filter((value) => value !== tagId) : [...item.tags, tagId], updatedAt: new Date().toISOString() };
      }),
    }));
  };

  changeBlocks = (cardId: string, updater: (blocks: Block[]) => Block[]): void => {
    this.mutate((current) => ({
      ...current,
      cards: current.cards.map((item) => (item.id === cardId ? { ...item, blocks: updater(item.blocks), updatedAt: new Date().toISOString() } : item)),
    }));
  };

  /** Upload images, then append the resulting blocks in one save. */
  addImages = async (cardId: string, files: File[]): Promise<void> => {
    if (!files.length) return;
    const appended: Block[] = [];
    for (const file of files) {
      try {
        const prepared = await prepareImage(file);
        const body = await readJson(
          await request(this.t, `${API}/asset`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(prepared),
          }),
        );
        const assetId = String(body.id);
        this.emit({ assets: new Set([...this.snapshot.assets, assetId]) });
        appended.push({ id: newId(), kind: "image", asset: assetId, caption: "" });
      } catch (error) {
        const text = errorText(error);
        this.setNotice({
          kind: "error",
          text: /过大|too large|413/.test(text) ? message(this.t, "imageTooLarge", { name: file.name }) : text,
        });
      }
    }
    if (!appended.length) return;
    this.changeBlocks(cardId, (blocks) => [...blocks, ...appended]);
    this.setNotice({ kind: "success", text: message(this.t, "imagesAdded", { count: appended.length }) });
  };

  /* ---------------- backups ---------------- */

  exportBackup = async (): Promise<{ filename: string; bytes: number; path: string } | undefined> => {
    try {
      await this.flush();
      this.setNotice({ kind: "info", text: this.t("exporting") });
      const body = await readJson(await request(this.t, `${API}/export`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
      this.setNotice({
        kind: "success",
        text: message(this.t, "exported", { name: body.filename, size: formatSize(body.bytes), path: body.path }),
      });
      return body as { filename: string; bytes: number; path: string };
    } catch (error) {
      this.setNotice({ kind: "error", text: errorText(error) });
      return undefined;
    }
  };

  listBackups = async (): Promise<{ directory: string; records: BackupRecord[] }> => {
    return (await readJson(await request(this.t, `${API}/backups`))) as { directory: string; records: BackupRecord[] };
  };

  deleteBackup = async (name: string): Promise<void> => {
    await readJson(await request(this.t, `${API}/backups/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }));
  };

  restoreBackup = async (name: string): Promise<void> => {
    try {
      const body = await readJson(await request(this.t, `${API}/backups/restore`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }));
      await this.reload();
      this.emit({ activeCardId: null, inlineCardId: null });
      this.setNotice({ kind: "success", text: message(this.t, "restoreDone", { cards: body.cards, assets: body.assets }) });
    } catch (error) {
      this.setNotice({ kind: "error", text: errorText(error) });
    }
  };

  importPayload = async (payload: unknown): Promise<void> => {
    try {
      this.setNotice({ kind: "info", text: this.t("importing") });
      const body = await readJson(await request(this.t, `${API}/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload }) }));
      await this.reload();
      this.emit({ activeCardId: null, inlineCardId: null });
      this.setNotice({ kind: "success", text: message(this.t, "importDone", { cards: body.cards, assets: body.assets }) });
    } catch (error) {
      this.setNotice({ kind: "error", text: errorText(error) });
    }
  };

  collectAssets = async (): Promise<void> => {
    try {
      const body = await readJson(await request(this.t, `${API}/collect`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
      this.setNotice({
        kind: "success",
        text: body.removed ? message(this.t, "collectDone", { removed: body.removed, size: formatSize(body.bytes) }) : this.t("collectNothing"),
      });
    } catch (error) {
      this.setNotice({ kind: "error", text: errorText(error) });
    }
  };

  downloadBackup = async (record: BackupRecord): Promise<void> => {
    try {
      const chunkSize = 4 * 1024 * 1024;
      const parts: BlobPart[] = [];
      for (let offset = 0; ; offset += chunkSize) {
        const response = await request(this.t, `${API}/download?name=${encodeURIComponent(record.name)}&offset=${offset}&length=${chunkSize}`);
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (!buffer.byteLength) break;
        parts.push(buffer);
        const total = Number(response.headers.get("x-dsh-works-total") || 0);
        if (offset + buffer.byteLength >= total) break;
      }
      downloadBlob(new Blob(parts, { type: "application/json" }), record.name);
    } catch (error) {
      this.setNotice({ kind: "error", text: errorText(error) });
    }
  };

  /** A hidden tab is the last reliable moment before the tab can be discarded. */
  installFlushOnHide(): () => void {
    const onHidden = () => {
      if (document.visibilityState === "hidden") void this.flush();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => document.removeEventListener("visibilitychange", onHidden);
  }
}

export const worksStore = new WorksStore();

/** Subscribe one component to the shared document. */
export function useWorks(): WorksSnapshot {
  return React.useSyncExternalStore(worksStore.subscribe, worksStore.getSnapshot, worksStore.getSnapshot);
}
