/**
 * dsh-helloai-works — "add this reply to the works", from the conversation.
 *
 * Two seats, one feature:
 *   - an icon in the finalized assistant message's action row, beside copy and
 *     the feedback thumbs, and
 *   - the draft dialog on the frame-wide overlay layer, because the conversation
 *     is not inside the works panel and a panel-scoped overlay could not cover it.
 *
 * The dialog is a draft, not a form: the reply is read out of the chat store on
 * click and both fields stay editable, so a half-useful answer can be trimmed
 * into a useful card before it is stored.
 */
import * as React from "react";
import { message, useWorks, worksStore } from "./works-store.js";
import type { Block, Translate } from "./works-store.js";

/* ------------------------------------------------------------------ *
 * Reading one reply out of the chat store
 * ------------------------------------------------------------------ */

/** The two chat-store slices this needs; both are stable store references. */
function useChatSlice(useChat: (selector: (state: any) => unknown) => any): { order: string[]; nodes: any } {
  const order = useChat((state) => state.order) as string[] | undefined;
  const nodes = useChat((state) => state.nodes);
  return { order: order ?? [], nodes };
}

/**
 * The text of the finalized assistant message behind one action row.
 *
 * The slot hands over only a `messageId`, so the message is matched in the chat
 * store: an assistant step keeps its settled message under `data.finalNode`,
 * which is exactly the node the action row was rendered for. Prose blocks are
 * joined the way the shipped copy action joins them.
 */
function messageTextOf(nodes: any, order: string[], messageId: unknown): string {
  for (const key of order) {
    const data = nodes?.get?.(key)?.data;
    const settled = data?.finalNode;
    if (!settled || settled.messageId !== messageId) continue;
    const blocks: Block[] | undefined = Array.isArray(settled.blocks) ? settled.blocks : data.blocks;
    if (!Array.isArray(blocks)) return "";
    return blocks
      .filter((block) => block?.kind === "text" && typeof block.text === "string")
      .map((block) => (block as { text: string }).text)
      .join("")
      .trim();
  }
  return "";
}

/** A title a person would have written: the reply's first real line, unmarked. */
function suggestTitle(text: string): string {
  const line = text
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  if (!line) return "";
  const plain = line.replace(/^#{1,6}\s+/, "").replace(/[*`_>]/g, "").trim();
  return plain.length > 60 ? `${plain.slice(0, 60)}…` : plain;
}

/* ------------------------------------------------------------------ *
 * The action in the message row
 * ------------------------------------------------------------------ */

/**
 * The filing glyph, drawn in the theme's own ink.
 *
 * The path is the icon set's, with its baked-in `#8a8a8a` replaced by
 * `currentColor`: the button then hands down the exact token the shipped action
 * row uses (`--dsw-alias-label-tertiary`, `label-secondary` under the pointer),
 * so this icon follows a theme switch like the copy and branch icons beside it.
 */
function CollectIcon() {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false" style={ICON_STYLE}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M870.4 0h-716.8C71.68 0 0 68.266667 0 153.6v716.8C0 955.733333 71.68 1024 153.6 1024h716.8c85.333333 0 153.6-68.266667 153.6-153.6v-716.8C1024 68.266667 952.32 0 870.4 0zM955.733333 870.4c0 47.786667-37.546667 85.333333-85.333333 85.333333h-716.8C105.813333 955.733333 68.266667 918.186667 68.266667 870.4v-716.8C68.266667 105.813333 105.813333 68.266667 153.6 68.266667h716.8C918.186667 68.266667 955.733333 105.813333 955.733333 153.6v716.8zM546.133333 238.933333h-68.266666v238.933334H238.933333v68.266666h238.933334v238.933334h68.266666v-238.933334h238.933334v-68.266666h-238.933334V238.933333z"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * The sheet, delivered two ways on purpose
 * ------------------------------------------------------------------ */

/**
 * The id of the one stylesheet this plugin keeps in the document head.
 *
 * The sheet used to be delivered only as a `<style>` node rendered inside the
 * overlay occupant, which made every surface outside that occupant (the action
 * button in the conversation, and the dialog itself if the occupant's node was
 * ever dropped) depend on a node React could remove. The head is the one place
 * a document keeps styles no matter which React tree is mounted, so the CSS
 * lives there and is refreshed — never duplicated — on every module evaluation
 * and every mount.
 */
const STYLE_ID = "hxw-collect-style";

/** Create (or refresh) the head stylesheet. Idempotent, so effects may call it freely. */
function installCollectStyles(): void {
  if (typeof document === "undefined" || document.head === null) return;
  const existing = document.getElementById(STYLE_ID);
  const tag = existing instanceof HTMLStyleElement ? existing : document.createElement("style");
  if (existing === null) {
    tag.id = STYLE_ID;
    tag.dataset.plugin = "@hello-heyongping/dsh-helloai-works";
    document.head.appendChild(tag);
  }
  if (tag.textContent !== COLLECT_CSS) tag.textContent = COLLECT_CSS;
}

// Module scope: the button and the dialog are styled from the first paint, even
// before either seat has mounted, and an HMR reload re-asserts the same node.
installCollectStyles();

/**
 * Geometry as inline styles, as a floor under the sheet.
 *
 * Inline declarations win over the sheet, so they restate the sheet's own values
 * and change nothing while the sheet is present. If it is ever missing, the
 * dialog still lands as a centred modal over a dimmed frame instead of a column
 * of native controls stacked in the window's top-left corner.
 */
const SIZE = "calc(28px + var(--dsh-content-font-delta, 0px))";
const ICON_SIZE = "calc(17px + var(--dsh-content-font-delta, 0px))";

const ACTION_STYLE: React.CSSProperties = {
  width: SIZE,
  height: SIZE,
  padding: 6,
  border: 0,
  borderRadius: "var(--dsw-radius-sm, 6px)",
  background: "transparent",
  color: "var(--dsw-alias-label-tertiary, #8a8a8a)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  boxSizing: "border-box",
};

const ICON_STYLE: React.CSSProperties = { width: ICON_SIZE, height: ICON_SIZE, display: "block", flex: "none" };

const LAYER_STYLE: React.CSSProperties = { pointerEvents: "none" };

const BACKDROP_STYLE: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9000,
  display: "grid",
  placeItems: "center",
  padding: 24,
  background: "var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 42%))",
  pointerEvents: "auto",
};

/** The dialog's own variables, so descendants resolve even without the sheet. */
const DIALOG_VARS: Record<string, string> = {
  "--hxw-accent": "var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary, #4d6bfe))",
  "--hxw-card": "var(--dsw-alias-bg-layer-1, #fff)",
  "--hxw-text": "var(--dsw-alias-label-primary, #16181d)",
  "--hxw-text-2": "var(--dsw-alias-label-secondary, #4b5157)",
  "--hxw-text-3": "var(--dsw-alias-label-tertiary, #7a8087)",
  "--hxw-border": "var(--dsw-alias-border-l1, rgb(0 0 0 / 8%))",
  "--hxw-border-2": "var(--dsw-alias-border-l2, rgb(0 0 0 / 12%))",
  "--hxw-hover": "var(--dsw-alias-interactive-bg-hover, rgb(0 0 0 / 6%))",
  "--hxw-danger": "var(--dsw-alias-state-error-primary, #dc2626)",
};

/** The two text fields and the name box, in case the sheet is absent. */
const FIELD_STYLE: React.CSSProperties = {
  width: "100%",
  border: "1px solid var(--hxw-border-2, rgb(0 0 0 / 12%))",
  borderRadius: 9,
  background: "var(--hxw-card, #fff)",
  color: "var(--hxw-text, #16181d)",
  font: "inherit",
  padding: "7px 10px",
  boxSizing: "border-box",
};

/** Tag chips and footer buttons, restated for the same reason as the fields. */
const CHIP_STYLE: React.CSSProperties = {
  border: "1px solid var(--hxw-border, rgb(0 0 0 / 8%))",
  borderRadius: 999,
  background: "transparent",
  padding: "2px 9px",
  fontSize: 12,
  cursor: "pointer",
  color: "var(--hxw-text-2, #4b5157)",
  font: "inherit",
};

const BUTTON_STYLE: React.CSSProperties = {
  border: "1px solid var(--hxw-border-2, rgb(0 0 0 / 12%))",
  borderRadius: 9,
  background: "var(--hxw-card, #fff)",
  color: "var(--hxw-text-2, #4b5157)",
  padding: "6px 14px",
  cursor: "pointer",
  font: "inherit",
};

const DIALOG_STYLE: React.CSSProperties = {
  ...DIALOG_VARS,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  width: "min(680px, 100%)",
  maxHeight: "min(80vh, 760px)",
  overflow: "auto",
  border: "1px solid var(--dsw-alias-border-l2, rgb(0 0 0 / 12%))",
  borderRadius: 14,
  background: "var(--dsw-alias-bg-overlay, var(--hxw-card))",
  color: "var(--hxw-text)",
  boxShadow: "0 18px 48px rgb(0 0 0 / 28%)",
  padding: "16px 18px 14px",
  fontSize: 13.5,
  lineHeight: 1.6,
  boxSizing: "border-box",
};

export function CollectAction({ messageId, useChat, t }: { messageId: unknown; useChat: any; t: Translate }) {
  const { order, nodes } = useChatSlice(useChat);
  const label = t("collectAction");
  // The sheet is re-asserted from the seat that is always mounted, so a layer
  // that arrives late (or loses its own <style> node) cannot leave this button
  // as an unstyled native button beside the shipped action icons.
  React.useEffect(() => {
    installCollectStyles();
  }, []);
  return (
    <button
      type="button"
      className="hxw-collect-action"
      title={label}
      aria-label={label}
      style={ACTION_STYLE}
      onClick={() => {
        const text = messageTextOf(nodes, order, messageId);
        worksStore.openCollect({ title: suggestTitle(text), body: text });
      }}
    >
      <CollectIcon />
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * The draft dialog, on the frame-wide overlay layer
 * ------------------------------------------------------------------ */

export function CollectLayer({ t }: { t: Translate }) {
  const snapshot = useWorks();
  const draft = snapshot.collect;
  const [toast, setToast] = React.useState<string | null>(null);
  const [stale, setStale] = React.useState(false);

  React.useEffect(() => {
    worksStore.setTranslate(t);
  }, [t]);

  // The head sheet is re-asserted on every mount and every open, so a reload of
  // this module (or anything that emptied the head) cannot leave the dialog bare.
  React.useEffect(() => {
    installCollectStyles();
  }, [draft]);

  // A fresh draft is a fresh attempt: clear the previous failure.
  React.useEffect(() => {
    if (draft) setStale(false);
  }, [draft]);

  React.useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!draft) {
    // The stylesheet rides along even with nothing to show, and lives in the
    // document head besides: the action button sits in the conversation, outside
    // this component, so neither seat may depend on the other being mounted.
    return (
      <div className="hxw-collect-layer" style={LAYER_STYLE}>
        <style>{COLLECT_CSS}</style>
        {toast ? (
          <div className="hxw-collect-toast" role="status">
            {toast}
          </div>
        ) : null}
      </div>
    );
  }

  const save = (): void => {
    const name = worksStore.saveCollect();
    if (name === null) setStale(true);
    else setToast(message(t, "collectSaved", { name }));
  };

  const lower = (value: string): string => value.trim().toLowerCase();
  const docTags = snapshot.doc?.tags ?? [];
  const chosen = new Set(draft.tags.map(lower));
  const isChosen = (name: string): boolean => chosen.has(lower(name));
  /** Names invented in this dialog, which the collection does not know yet. */
  const invented = draft.tags.filter((name) => !docTags.some((tag) => lower(tag.name) === lower(name)));

  const toggleTag = (name: string, on: boolean): void => {
    const key = lower(name);
    worksStore.patchCollect({
      tags: on ? draft.tags.filter((value) => lower(value) !== key) : [...draft.tags, name.trim()],
    });
  };

  const commitNewTag = (): void => {
    const name = draft.newTag.trim();
    if (!name) return;
    const key = lower(name);
    worksStore.patchCollect({ tags: chosen.has(key) ? draft.tags : [...draft.tags, name], newTag: "" });
  };

  return (
    <div className="hxw-collect-layer" style={LAYER_STYLE}>
      <style>{COLLECT_CSS}</style>
      <div
        className="hxw-collect-backdrop"
        style={BACKDROP_STYLE}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) worksStore.closeCollect();
        }}
      >
        <div
          className="hxw-collect-dialog"
          style={DIALOG_STYLE}
          role="dialog"
          aria-modal="true"
          aria-label={t("collectTitle")}
          onKeyDown={(event) => {
            if (event.key === "Escape") worksStore.closeCollect();
          }}
        >
          <div className="hxw-collect-head">{t("collectTitle")}</div>

          <label className="hxw-collect-field">
            <span className="hxw-collect-label">{t("collectFieldTitle")}</span>
            <input
              className="hxw-collect-input"
              style={FIELD_STYLE}
              value={draft.title}
              placeholder={t("titlePlaceholder")}
              onChange={(event) => worksStore.patchCollect({ title: event.target.value })}
            />
          </label>

          <label className="hxw-collect-field hxw-collect-field-grow">
            <span className="hxw-collect-label">{t("collectFieldBody")}</span>
            <textarea
              className="hxw-collect-text"
              style={{ ...FIELD_STYLE, minHeight: 150, resize: "vertical", lineHeight: 1.6, whiteSpace: "pre-wrap" }}
              value={draft.body}
              spellCheck={false}
              onChange={(event) => worksStore.patchCollect({ body: event.target.value })}
            />
          </label>

          {/* Tags are chosen by name and only materialise on save, so filing a
              reply under a brand-new tag costs nothing if the dialog is closed. */}
          <div className="hxw-collect-field">
            <span className="hxw-collect-label">{t("tags")}</span>
            <div className="hxw-collect-tags">
              {docTags.map((tag) => (
                <button
                  key={tag.id}
                  type="button"
                  className="hxw-collect-chip"
                  style={CHIP_STYLE}
                  data-on={isChosen(tag.name)}
                  onClick={() => toggleTag(tag.name, isChosen(tag.name))}
                >
                  {tag.name}
                </button>
              ))}
              {invented.map((name) => (
                <button
                  key={`new:${name}`}
                  type="button"
                  className="hxw-collect-chip"
                  style={CHIP_STYLE}
                  data-on="true"
                  data-new="true"
                  title={t("collectNewTagHint")}
                  onClick={() => toggleTag(name, true)}
                >
                  {name}
                </button>
              ))}
              <input
                className="hxw-collect-newtag"
                style={{ ...FIELD_STYLE, width: "9.5em", borderStyle: "dashed", borderRadius: 999, padding: "2px 9px", fontSize: 12 }}
                value={draft.newTag}
                placeholder={`＋ ${t("newTag")}`}
                onChange={(event) => worksStore.patchCollect({ newTag: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  // Enter files the name here; it must not reach anything else.
                  event.preventDefault();
                  commitNewTag();
                }}
              />
            </div>
          </div>

          {draft.body.trim() ? null : <p className="hxw-collect-hint">{t("collectNoText")}</p>}
          {stale ? <p className="hxw-collect-error">{t("collectStale")}</p> : null}

          <div className="hxw-collect-foot">
            <button type="button" className="hxw-collect-btn" style={BUTTON_STYLE} onClick={() => worksStore.closeCollect()}>
              {t("cancel")}
            </button>
            <button
              type="button"
              className="hxw-collect-btn hxw-collect-primary"
              style={{
                ...BUTTON_STYLE,
                borderColor: "var(--hxw-accent, #4d6bfe)",
                background: "var(--hxw-accent, #4d6bfe)",
                color: "var(--dsw-alias-label-primary-foreground, #fff)",
                fontWeight: 600,
              }}
              onClick={save}
            >
              {t("save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Styles for both seats
 * ------------------------------------------------------------------ */

const COLLECT_CSS = `
.hxw-collect-action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));padding:6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center}
.hxw-collect-action svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px))}
.hxw-collect-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.hxw-collect-action:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));outline-offset:1px}

/* The overlay layer is click-through, so only the real surfaces opt back in. */
.hxw-collect-layer{pointer-events:none}
.hxw-collect-backdrop{position:fixed;inset:0;z-index:9000;display:grid;place-items:center;padding:24px;background:var(--dsw-alias-bg-mask-1,rgb(0 0 0 / 42%));pointer-events:auto}
.hxw-collect-dialog{--hxw-accent:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));--hxw-accent-soft:color-mix(in srgb,var(--hxw-accent) 14%,transparent);--hxw-border:var(--dsw-alias-border-l1);--hxw-border-2:var(--dsw-alias-border-l2);--hxw-card:var(--dsw-alias-bg-layer-1);--hxw-text:var(--dsw-alias-label-primary);--hxw-text-2:var(--dsw-alias-label-secondary);--hxw-text-3:var(--dsw-alias-label-tertiary);--hxw-hover:var(--dsw-alias-interactive-bg-hover);--hxw-danger:var(--dsw-alias-state-error-primary,#dc2626);display:flex;flex-direction:column;gap:10px;width:min(680px,100%);max-height:min(80vh,760px);overflow:auto;border:1px solid var(--hxw-border-2);border-radius:14px;background:var(--dsw-alias-bg-overlay,var(--hxw-card));color:var(--hxw-text);box-shadow:0 18px 48px rgb(0 0 0 / 28%);padding:16px 18px 14px;font-size:13.5px;line-height:1.6}
.hxw-collect-dialog *,.hxw-collect-dialog *::before,.hxw-collect-dialog *::after{box-sizing:border-box}
.hxw-collect-dialog button{font:inherit;color:inherit}
.hxw-collect-head{font-size:15px;font-weight:650}
.hxw-collect-field{display:flex;flex-direction:column;gap:4px;min-height:0}
.hxw-collect-field-grow{flex:1;min-height:0}
.hxw-collect-label{color:var(--hxw-text-3);font-size:11.5px}
.hxw-collect-input,.hxw-collect-text{width:100%;border:1px solid var(--hxw-border-2);border-radius:9px;background:var(--hxw-card);color:var(--hxw-text);font:inherit;padding:7px 10px}
.hxw-collect-input:focus-visible,.hxw-collect-text:focus-visible{outline:none;border-color:var(--hxw-accent);box-shadow:0 0 0 3px var(--hxw-accent-soft)}
.hxw-collect-text{flex:1;min-height:150px;resize:vertical;overflow:auto;white-space:pre-wrap;line-height:1.6}
/* Tag row: the collection's own chips, the names invented here, and the box that
   makes a new one. Selection is by name, so an invented chip is just another
   toggle until the save turns it into a real tag. */
.hxw-collect-tags{display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.hxw-collect-chip{border:1px solid var(--hxw-border);border-radius:999px;background:0 0;padding:2px 9px;font-size:12px;cursor:pointer;color:var(--hxw-text-2);transition:background .14s,border-color .14s,color .14s}
.hxw-collect-chip:hover{border-color:var(--hxw-accent);color:var(--hxw-text)}
.hxw-collect-chip[data-on=true]{background:var(--hxw-accent-soft);border-color:var(--hxw-accent);color:var(--hxw-accent)}
.hxw-collect-chip[data-new=true]{border-style:dashed}
.hxw-collect-chip:focus-visible{outline:2px solid var(--hxw-accent);outline-offset:1px}
.hxw-collect-newtag{border:1px dashed var(--hxw-border-2);border-radius:999px;background:0 0;color:var(--hxw-text);padding:2px 9px;font:inherit;font-size:12px;width:9.5em}
.hxw-collect-newtag::placeholder{color:var(--hxw-text-3)}
.hxw-collect-newtag:focus-visible{outline:none;border-color:var(--hxw-accent);border-style:solid}
.hxw-collect-hint{margin:0;color:var(--hxw-text-3);font-size:12px}
.hxw-collect-error{margin:0;color:var(--hxw-danger);font-size:12px}
.hxw-collect-foot{display:flex;justify-content:flex-end;gap:8px;padding-top:2px}
.hxw-collect-btn{border:1px solid var(--hxw-border-2);border-radius:9px;background:var(--hxw-card);color:var(--hxw-text-2);padding:6px 14px;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.hxw-collect-btn:hover{background:var(--hxw-hover);border-color:var(--hxw-accent);color:var(--hxw-text)}
.hxw-collect-btn:focus-visible{outline:2px solid var(--hxw-accent);outline-offset:1px}
.hxw-collect-primary{border-color:var(--hxw-accent);background:var(--hxw-accent);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}
.hxw-collect-primary:hover{background:color-mix(in srgb,var(--hxw-accent) 86%,#000);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.hxw-collect-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9100;max-width:min(560px,92vw);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);padding:9px 14px;font-size:13px;box-shadow:0 8px 24px rgb(0 0 0 / 18%);pointer-events:auto}
`;
