/**
 * dsh-helloai-works — `@` references to the collection, inside the composer.
 *
 * The composer's trigger pipeline (`ctx.inputTriggers`) is the supported way to
 * put something behind a trigger character: a source lists candidates for the
 * text typed after `@`, a pick inserts one chip, and the chip's *owner*
 * serializes it into the model's view when the message is submitted. That last
 * step is what makes this worth having: the draft keeps a short, readable chip
 * («人物设定»), while the model receives the card's text.
 *
 * Two kinds of reference, one list:
 *   - a single card — pull exactly the piece of writing you mean;
 *   - a tag group  — pull everything filed under one tag, which is what a novel
 *     actually needs ("@人物" → every character sheet, not one of them).
 *
 * The source joins the shipped `@file` / `@session` source instead of claiming a
 * trigger of its own, so `@` stays one menu with one list per kind.
 *
 * Nothing here is imported from a Harness Client package: the trigger contract
 * is restated structurally below, exactly as DSH's plugin guidance requires.
 */
import { buildSearchIndex, excerpt, formatTime, message, searchCards, selectCards, worksStore } from "./works-store.js";
import type { Card, Doc, Tag, Translate } from "./works-store.js";

/* ------------------------------------------------------------------ *
 * The trigger contract (structural, as `ctx.inputTriggers` uses it)
 * ------------------------------------------------------------------ */

/** One row in the trigger menu; `section` is rendered verbatim as a list header. */
export type TriggerRow = {
  name: string;
  description?: string;
  icon?: string;
  section?: string;
  value?: string;
  drill?: boolean;
};

/** What a pick may do: insert text, insert a reference chip, or claim the token. */
export type TriggerOutcome =
  | { text: string; continue?: boolean }
  | { insert: { source: string; ref: string; label?: string; appearance?: string; clipboardText: string } }
  | "handled"
  | undefined;

/** The session projection a source is handed (agent-backed identity). */
export type TriggerSession = { sessionId: string };

export type TriggerRequest = { query: string; quoted?: boolean; drilled?: boolean; position?: string; signal?: AbortSignal };

export type TriggerSource = {
  trigger: string;
  name: string;
  /** Menu position among the sources sharing this trigger; lower comes first. */
  order?: number;
  showGroupTitle?: boolean;
  /**
   * Candidates for one query, **as a Promise** — the pipeline settles a source
   * by chaining its answer (`source.candidates(...).then(...)`), so a plain array
   * throws inside the menu's fetch loop, the loop aborts there, and every group
   * behind it stays `pending` (which is rendered as the loading skeleton, with no
   * rows) for as long as the menu is open. The type therefore admits nothing but
   * a promise; an `async` method, whose early `return []` is a promise too, is
   * the shape to reach for.
   */
  candidates: (session: TriggerSession, request: TriggerRequest) => Promise<TriggerRow[]>;
  onPick: (pick: {
    candidate: TriggerRow;
    session: TriggerSession;
    action?: string;
    position?: string;
    via?: string;
    span?: unknown;
  }) => TriggerOutcome | Promise<TriggerOutcome>;
  openReference?: (session: TriggerSession, reference: { ref: string; appearance?: string }) => boolean;
  codec?: {
    clipboardText: (ref: string) => string;
    serialize: (ref: string, signal?: AbortSignal) => Promise<string>;
  };
};

/** The `ctx.inputTriggers` face this plugin uses. */
export type TriggerService = { registerSource: (source: TriggerSource) => () => void };

/**
 * Whether the composer pipeline took our source.
 *
 * A plain module-level fact rather than store state: it is decided once while
 * the plugin applies, and the panel only ever reads it. Activation must not
 * write to the shared store — that would be a state update from outside React,
 * at the exact moment the shell is mounting around us.
 */
export const cardSourceState: { ready: boolean } = { ready: false };

/** The source's registry name — also the `source` every chip we insert carries. */
export const CARD_SOURCE = "works-card";
/** Single-card rows offered at once; typing narrows the list, so a screenful is plenty. */
const MAX_ROWS = 12;
/** Whole-group rows offered at once. */
const MAX_TAG_ROWS = 5;
/**
 * How much of one card reaches the model. A card may hold 200k characters per
 * block, and a reference is expanded into the prompt on every submit, so an
 * unbounded card would be a foot-gun rather than a feature.
 */
export const MAX_CARD_PROMPT_CHARS = 8000;
/** How much one whole-tag reference may add to the prompt, all cards together. */
export const MAX_GROUP_PROMPT_CHARS = 20_000;
/**
 * Reference ids are opaque strings the source owns. A tag group carries a
 * prefix, so the two kinds can never be mistaken for each other.
 */
const TAG_REF = "tag:";

/* ------------------------------------------------------------------ *
 * Card → prompt text
 * ------------------------------------------------------------------ */

function tagNamesOf(card: Card, doc: Doc | null): string[] {
  return card.tags.map((tagId) => doc?.tags.find((tag) => tag.id === tagId)?.name ?? "").filter(Boolean);
}

/**
 * One card as the model reads it.
 *
 * The header names the card and its filing (tags, source, date) so the model can
 * quote it back by name; the body keeps the block order the user arranged, with
 * an image block reduced to its caption — the bytes live on disk and the model
 * cannot see them from here.
 *
 * @param card - the card to serialize.
 * @param doc - the collection the card belongs to, for tag names.
 * @param t - the namespace translator.
 * @returns the prompt text, truncated when the card is longer than the budget.
 */
export function cardPromptText(card: Card, doc: Doc | null, t: Translate): string {
  const head = [message(t, "mentionCardHead", { title: card.title.trim() || t("untitled") })];
  const tags = tagNamesOf(card, doc);
  if (tags.length) head.push(message(t, "mentionTags", { names: tags.join("、") }));
  if (card.source.trim()) head.push(message(t, "mentionSource", { source: card.source.trim() }));
  head.push(message(t, "mentionCollected", { date: formatTime(card.createdAt, false) }));

  const body: string[] = [];
  for (const block of card.blocks) {
    if (block.kind === "text") {
      const text = block.text.trim();
      if (text) body.push(text);
    } else {
      const caption = block.caption.trim();
      body.push(caption ? message(t, "mentionImage", { caption }) : t("mentionImageBare"));
    }
  }

  let text = body.join("\n\n");
  if (text.length > MAX_CARD_PROMPT_CHARS) {
    text = `${text.slice(0, MAX_CARD_PROMPT_CHARS)}\n${message(t, "mentionTruncated", { total: text.length })}`;
  }
  return `${head.join("\n")}\n\n${text}`.trim();
}

/**
 * One tag as a group: every card filed under it, newest first, each in the same
 * shape a single card uses.
 *
 * The group is capped so that one careless `@` cannot eat the whole window; when
 * the budget runs out the text says how many cards were left out, because a
 * silently short context is worse than a stated one.
 *
 * @param tag - the referenced tag.
 * @param cards - its cards, newest first.
 * @param doc - the collection, for tag names.
 * @param t - the namespace translator.
 */
export function groupPromptText(tag: Tag, cards: Card[], doc: Doc | null, t: Translate): string {
  if (!cards.length) return message(t, "mentionGroupEmpty", { name: tag.name });
  const head = message(t, "mentionGroupHead", { name: tag.name, count: cards.length });

  const parts: string[] = [];
  let used = 0;
  for (const card of cards) {
    const text = cardPromptText(card, doc, t);
    if (parts.length && used + text.length > MAX_GROUP_PROMPT_CHARS) break;
    parts.push(text);
    used += text.length;
  }
  const omitted = cards.length - parts.length;
  const tail = omitted > 0 ? `\n${message(t, "mentionGroupTruncated", { included: parts.length, omitted })}` : "";
  return `${head}\n\n${parts.join("\n\n")}${tail}`;
}

/* ------------------------------------------------------------------ *
 * The `@` source
 * ------------------------------------------------------------------ */

/**
 * The index, the ordered list and the per-tag grouping are rebuilt only when the
 * document object changes. `candidates` runs once per keystroke while the menu
 * is open, and the store replaces its document wholesale on every edit, so
 * identity is exactly the right cache key.
 */
let cache: { doc: Doc | null; index: Map<string, string>; ordered: Card[]; byTag: Map<string, Card[]> } | null = null;

function readCollection(): { doc: Doc | null; index: Map<string, string>; ordered: Card[]; byTag: Map<string, Card[]> } {
  const doc = worksStore.getSnapshot().doc;
  if (cache === null || cache.doc !== doc) {
    const ordered = selectCards(doc, { activeTag: null, sortDesc: true });
    const byTag = new Map<string, Card[]>();
    for (const card of ordered) {
      for (const tagId of card.tags) {
        const list = byTag.get(tagId);
        if (list) list.push(card);
        else byTag.set(tagId, [card]);
      }
    }
    cache = { doc, index: buildSearchIndex(doc), ordered, byTag };
  }
  return cache;
}

/** The one-line hint under a row: where the card is filed, then what it says. */
function describe(card: Card, doc: Doc | null, t: Translate): string {
  const names = card.tags
    .map((tagId) => doc?.tags.find((tag) => tag.id === tagId)?.name ?? "")
    .filter(Boolean)
    .slice(0, 3)
    .join(" · ");
  const brief = excerpt(card, 36);
  return [names, brief].filter(Boolean).join(" · ");
}

function cardOf(ref: string | undefined): Card | undefined {
  if (!ref) return undefined;
  return worksStore.getSnapshot().doc?.cards.find((card) => card.id === ref);
}

/**
 * Build the `@` source for the collection.
 *
 * @param options - the namespace translator and the card opener the panel uses.
 * @returns a trigger source ready for `ctx.inputTriggers.registerSource`.
 */
export function createCardSource(options: { t: Translate; openCard: (cardId: string) => void }): TriggerSource {
  const { t, openCard } = options;

  /** The rows for one query. Only `candidates` calls this, and it may throw. */
  const collectRows = (query: string): TriggerRow[] => {
    // The composer can be the first surface a session touches, so opening `@`
    // is also what starts loading the collection.
    worksStore.start();
    const { doc, index, ordered, byTag } = readCollection();
    if (!doc?.cards.length) return [];

    const cardRows: TriggerRow[] = searchCards(ordered, query, index)
      .slice(0, MAX_ROWS)
      .map((card) => ({
        name: card.title.trim() || t("untitled"),
        description: describe(card, doc, t),
        icon: "file",
        section: t("mentionSection"),
        value: card.id,
      }));

    // A tag is a way to pull a whole shelf of the collection at once: file every
    // character sheet under 人物 and `@人物` brings the cast with it.
    const needle = query.trim().toLowerCase();
    const tagRows: TriggerRow[] = (doc.tags ?? [])
      .filter((tag) => (needle ? tag.name.toLowerCase().includes(needle) : true))
      .filter((tag) => (byTag.get(tag.id)?.length ?? 0) > 0)
      .slice(0, needle ? MAX_TAG_ROWS : 3)
      .map((tag) => ({
        name: tag.name,
        description: message(t, "mentionTagRows", { count: byTag.get(tag.id)?.length ?? 0 }),
        icon: "folder",
        section: t("mentionTagSection"),
        value: `${TAG_REF}${tag.id}`,
      }));

    return [...cardRows, ...tagRows];
  };

  /** Build the chip one picked row inserts. May throw; `onPick` contains it. */
  const pickCard = (candidate: TriggerRow): TriggerOutcome => {
    const value = candidate?.value;
    if (!value) return undefined;

    if (value.startsWith(TAG_REF)) {
      const tagId = value.slice(TAG_REF.length);
      const tag = worksStore.getSnapshot().doc?.tags.find((item) => item.id === tagId);
      if (!tag) return undefined;
      return {
        insert: {
          source: CARD_SOURCE,
          ref: value,
          label: tag.name,
          appearance: "file",
          clipboardText: `@${tag.name}`,
        },
      };
    }

    const card = cardOf(value);
    if (!card) return undefined;
    const label = card.title.trim() || t("untitled");
    return {
      insert: {
        source: CARD_SOURCE,
        ref: card.id,
        label,
        appearance: "file",
        clipboardText: `@${label}`,
      },
    };
  };

  return {
    trigger: "@",
    name: CARD_SOURCE,
    // The menu sorts sources by `order` (registration order breaks ties) and the
    // shipped file/session source registers without one, i.e. at 0. The
    // collection is what this plugin is for, so it sits above them: a list
    // nobody scrolls to is a feature nobody has.
    order: -1,
    // Every row carries its own section title, which also suppresses the group
    // title the menu would otherwise translate through *its* dictionary.
    showGroupTitle: false,

    /**
     * The menu asks every source for rows on each keystroke, and a source that
     * throws synchronously takes the whole menu down with it: the caller's loop
     * over the roster aborts and *every* group — including the shipped file and
     * session lists — stays on its loading skeleton forever. So this method
     * never throws: a broken collection yields no rows, not a dead menu.
     *
     * It must also answer with a **Promise**, which is why it is `async` even
     * though the work below is synchronous: the pipeline settles a source by
     * chaining its answer (`source.candidates(...).then(...)`), and an `Array`
     * has no `.then` — returning one throws inside that loop, before any later
     * source is even asked, and the menu hangs on skeletons with no rows. An
     * `async` method is the one shape that is a Promise on every path, the
     * early `return []` included.
     */
    async candidates(_session, request) {
      try {
        const query = typeof request?.query === "string" ? request.query : "";
        // The collection loads lazily; opening `@` is also a wake-up call. Its
        // rows appear on the next keystroke rather than blocking this answer.
        if (request?.signal?.aborted) return [];
        return collectRows(query);
      } catch (error) {
        console.warn("[dsh-helloai-works] @ card candidates failed:", error);
        return [];
      }
    },

    /** Never throws either: a pick that cannot be built inserts nothing. */
    onPick({ candidate }) {
      try {
        return pickCard(candidate);
      } catch (error) {
        console.warn("[dsh-helloai-works] @ card pick failed:", error);
        return undefined;
      }
    },

    openReference(_session, { ref }) {
      // Only a single card has somewhere to open; a group is a query, not a place.
      if (ref.startsWith(TAG_REF) || !cardOf(ref)) return false;
      openCard(ref);
      return true;
    },

    codec: {
      clipboardText(ref) {
        if (ref.startsWith(TAG_REF)) {
          const tag = worksStore.getSnapshot().doc?.tags.find((item) => item.id === ref.slice(TAG_REF.length));
          return `@${tag?.name ?? t("untitled")}`;
        }
        return `@${cardOf(ref)?.title.trim() || t("untitled")}`;
      },
      /**
       * The model's view of the chip. A card or tag deleted between insertion
       * and submit must not reject here — a rejected serializer blocks the whole
       * send — so the reference degrades to a sentence saying so.
       */
      async serialize(ref) {
        const { doc, byTag } = readCollection();

        if (ref.startsWith(TAG_REF)) {
          const tagId = ref.slice(TAG_REF.length);
          const tag = doc?.tags.find((item) => item.id === tagId);
          if (!tag) return message(t, "mentionTagGone", { id: ref });
          return groupPromptText(tag, byTag.get(tagId) ?? [], doc, t);
        }

        const card = doc?.cards.find((item) => item.id === ref);
        if (!card) return message(t, "mentionCardGone", { id: ref });
        return cardPromptText(card, doc, t);
      },
    },
  };
}
