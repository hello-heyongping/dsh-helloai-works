/**
 * dsh-helloai-works — the card itself, as a list of text and image blocks.
 *
 * This is the body of the right-Sidebar tab (and the panel's fallback column
 * when the Sidebar refuses the tab), so it is laid out for a narrow column:
 * one stacked scroller, no horizontal chrome.
 */
import * as React from "react";
import { NoticeBar } from "./notice.js";
import { assetUrl, message, newId, useWorks, worksStore } from "./works-store.js";
import type { Block, Card, Translate } from "./works-store.js";

/* ------------------------------------------------------------------ *
 * Building blocks
 * ------------------------------------------------------------------ */

/**
 * Measuring the textarea has to happen before paint on the client, but the
 * server renderer has no layout and warns about `useLayoutEffect`. The plugin
 * only ever mounts in a browser; this keeps the render-based self-test quiet.
 */
const useMeasureEffect = typeof document === "undefined" ? React.useEffect : React.useLayoutEffect;

/** Textarea that grows with its content, so a block list never needs its own scroller. */
function AutoTextarea(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
}) {
  const ref = React.useRef<HTMLTextAreaElement | null>(null);
  const resize = React.useCallback(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, []);
  // Content can also arrive from a reload (import, restore) without a keystroke.
  useMeasureEffect(resize, [props.value, resize]);
  return (
    <textarea
      ref={ref}
      className={props.className}
      value={props.value}
      rows={1}
      spellCheck={false}
      placeholder={props.placeholder}
      autoFocus={props.autoFocus}
      onChange={(event) => props.onChange(event.target.value)}
      onInput={resize}
    />
  );
}

/**
 * The reorder arrow, from the icon set, in the theme's ink.
 *
 * One glyph for both directions: the set only draws "up", and the down control
 * is that same arrow turned half a circle — so the two can never drift apart.
 */
function MoveIcon({ down = false }: { down?: boolean }) {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false" data-dir={down ? "down" : "up"}>
      <path
        fill="currentColor"
        d="M842.009071 396.492525l-296.036284-295.86427c-18.749538-18.749538-49.196036-18.749538-67.945574 0l-295.86427 296.036284c-26.662187 26.662187-4.472367 73.278011 30.446498 73.278011l146.728036 0 0 420.5745c0 25.974131 20.985721 47.131866 47.131866 47.131866l211.233328 0c25.974131 0 47.131866-20.985721 47.131866-47.131866L664.834537 469.770536 811.906602 469.770536C847.513523 469.770536 867.811188 422.63867 842.009071 396.492525z"
      />
    </svg>
  );
}

/**
 * 来源 — a link, drawn in the theme's ink.
 *
 * The field holds a link, a book title or any other origin, so it is an optional
 * detail rather than a row of its own: the card body belongs to the tags and the
 * content blocks, and this glyph beside the collected date is the whole of it
 * until someone clicks. Painted with `currentColor` so the button decides the
 * hue — quiet at rest, accented when a source is set.
 */
function SourceIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon="source"
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

type BlockRowProps = {
  block: Block;
  index: number;
  total: number;
  /** Localised control names, passed as strings so memo still compares cheaply. */
  moveUpLabel: string;
  moveDownLabel: string;
  onText: (blockId: string, value: string) => void;
  onCaption: (blockId: string, value: string) => void;
  onMove: (blockId: string, delta: number) => void;
  onRemove: (blockId: string) => void;
};

/**
 * One text or image block. Memoised so typing in one textarea does not re-render
 * every other block on a long card.
 */
const BlockRow = React.memo(function BlockRow(props: BlockRowProps) {
  const { block, index, total } = props;
  const [broken, setBroken] = React.useState(false);
  return (
    <li className="hxw-block" data-kind={block.kind}>
      <div className="hxw-block-gutter" aria-hidden="true">
        <span className="hxw-block-index">{index + 1}</span>
      </div>
      <div className="hxw-block-body">
        {block.kind === "text" ? (
          <AutoTextarea className="hxw-text-block" value={block.text} onChange={(value) => props.onText(block.id, value)} />
        ) : (
          <figure className="hxw-figure">
            {broken ? (
              <div className="hxw-image-missing">🖼</div>
            ) : (
              <img className="hxw-image" src={assetUrl(block.asset)} alt={block.caption} loading="lazy" decoding="async" onError={() => setBroken(true)} />
            )}
            <input className="hxw-caption" value={block.caption} placeholder="\u00a0" onChange={(event) => props.onCaption(block.id, event.target.value)} />
          </figure>
        )}
      </div>
      <div className="hxw-block-tools">
        <button type="button" title={props.moveUpLabel} aria-label={props.moveUpLabel} disabled={index === 0} onClick={() => props.onMove(block.id, -1)}>
          <MoveIcon />
        </button>
        <button
          type="button"
          title={props.moveDownLabel}
          aria-label={props.moveDownLabel}
          disabled={index === total - 1}
          onClick={() => props.onMove(block.id, 1)}
        >
          <MoveIcon down />
        </button>
        <button type="button" className="hxw-danger" title="✕" onClick={() => props.onRemove(block.id)}>
          ✕
        </button>
      </div>
    </li>
  );
});

/* ------------------------------------------------------------------ *
 * Tag picker shared by the card body
 * ------------------------------------------------------------------ */

function TagPicker({ card, t }: { card: Card; t: Translate }) {
  const snapshot = useWorks();
  const [draft, setDraft] = React.useState("");
  return (
    <div className="hxw-field">
      <label>{t("tags")}</label>
      <div className="hxw-tag-picker">
        {(snapshot.doc?.tags ?? []).map((tag) => (
          <button key={tag.id} type="button" className="hxw-chip-btn" data-on={card.tags.includes(tag.id)} onClick={() => worksStore.toggleCardTag(card.id, tag.id)}>
            {tag.name}
          </button>
        ))}
        <input
          className="hxw-chip-add"
          placeholder={`＋ ${t("newTag")}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            worksStore.addTag((event.target as HTMLInputElement).value, card.id);
            setDraft("");
          }}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */

export function CardView({ cardId, t }: { cardId: string; t: Translate }) {
  const snapshot = useWorks();
  const card = snapshot.doc?.cards.find((item) => item.id === cardId) ?? null;
  const [busy, setBusy] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [sourceOpen, setSourceOpen] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    worksStore.setTranslate(t);
    worksStore.start();
    return worksStore.installFlushOnHide();
  }, [t]);

  // The editor belongs to the card it was opened on: switching cards closes it,
  // so a source box is never left sitting over a card it does not describe.
  React.useEffect(() => setSourceOpen(false), [cardId]);

  const changeBlocks = React.useCallback((updater: (blocks: Block[]) => Block[]) => worksStore.changeBlocks(cardId, updater), [cardId]);

  const onText = React.useCallback(
    (blockId: string, value: string) => changeBlocks((blocks) => blocks.map((block) => (block.id === blockId && block.kind === "text" ? { ...block, text: value } : block))),
    [changeBlocks],
  );
  const onCaption = React.useCallback(
    (blockId: string, value: string) => changeBlocks((blocks) => blocks.map((block) => (block.id === blockId && block.kind === "image" ? { ...block, caption: value } : block))),
    [changeBlocks],
  );
  const onMove = React.useCallback(
    (blockId: string, delta: number) =>
      changeBlocks((blocks) => {
        const index = blocks.findIndex((block) => block.id === blockId);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= blocks.length) return blocks;
        const next = [...blocks];
        const [moved] = next.splice(index, 1);
        next.splice(target, 0, moved);
        return next;
      }),
    [changeBlocks],
  );
  const onRemove = React.useCallback((blockId: string) => changeBlocks((blocks) => blocks.filter((block) => block.id !== blockId)), [changeBlocks]);

  /** Correct the day while keeping the stored time of day. */
  const setCollected = (target: Card, day: string): void => {
    if (!day) return;
    const previous = new Date(target.createdAt);
    const timeOfDay = Number.isNaN(previous.getTime()) ? "00:00:00.000" : previous.toISOString().slice(11);
    const next = new Date(`${day}T${timeOfDay}`);
    if (Number.isNaN(next.getTime())) return;
    worksStore.updateCard(target.id, { createdAt: next.toISOString() });
  };

  const addImages = React.useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setBusy(true);
      try {
        await worksStore.addImages(cardId, files);
      } finally {
        setBusy(false);
        if (fileInput.current) fileInput.current.value = "";
      }
    },
    [cardId],
  );

  const imageFilesFrom = (list: FileList | File[] | null | undefined): File[] =>
    list ? [...list].filter((file) => file.type.startsWith("image/")) : [];

  if (!card) {
    return (
      <section className="hxw-cv hxw-cv-empty">
        <style>{CARD_CSS}</style>
        <div className="hxw-empty">
          <div>{snapshot.loading ? "…" : t("cardGone")}</div>
        </div>
      </section>
    );
  }

  const saveLabel =
    snapshot.saving === "saving"
      ? t("saving")
      : snapshot.saving === "error"
        ? t("saveFailed")
        : snapshot.savedAt
          ? message(t, "saved", { time: snapshot.savedAt.slice(11, 16) })
          : "";

  return (
    <section
      className="hxw-cv"
      onPaste={(event) => {
        const files = imageFilesFrom(event.clipboardData?.files);
        if (!files.length) return;
        event.preventDefault();
        void addImages(files);
      }}
      onDragOver={(event) => {
        if ([...(event.dataTransfer?.types ?? [])].includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void addImages(imageFilesFrom(event.dataTransfer?.files));
      }}
    >
      <style>{CARD_CSS}</style>

      <header className="hxw-cv-head">
        <AutoTextarea
          className="hxw-cv-title"
          value={card.title}
          placeholder={t("titlePlaceholder")}
          autoFocus={!card.title}
          onChange={(value) => worksStore.updateCard(card.id, { title: value })}
        />
        <div className="hxw-cv-meta">
          {/* The collected time is part of the record, and the one field no other
              part of the UI can correct. Only the day is edited; the time stands. */}
          <label className="hxw-cv-collected">
            {t("collected")}
            <input type="date" value={card.createdAt.slice(0, 10)} onChange={(event) => setCollected(card, event.target.value)} />
          </label>
          {/* 来源 is optional, so it is a glyph beside the date and nothing more:
              closed, it holds no space; open, one input appears under the title.
              The filled tint is the only sign that a source is set — hover or
              focus reads it out through the title. */}
          <button
            type="button"
            className="hxw-src-btn"
            data-on={card.source ? "true" : "false"}
            data-open={sourceOpen ? "true" : "false"}
            title={card.source || t("source")}
            aria-label={t("source")}
            aria-expanded={sourceOpen}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setSourceOpen((open) => !open)}
          >
            <SourceIcon />
          </button>
          <span className="hxw-save" data-state={snapshot.saving}>
            {saveLabel}
          </span>
        </div>
        {sourceOpen ? (
          <input
            className="hxw-source-input"
            autoFocus
            value={card.source}
            placeholder={t("sourcePlaceholder")}
            aria-label={t("source")}
            onChange={(event) => worksStore.updateCard(card.id, { source: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Escape") setSourceOpen(false);
            }}
            onBlur={() => setSourceOpen(false)}
          />
        ) : null}
      </header>

      <div className="hxw-cv-body">
        <TagPicker card={card} t={t} />

        <ul className="hxw-blocks">
          {card.blocks.map((block, index) => (
            <BlockRow
              key={block.id}
              block={block}
              index={index}
              total={card.blocks.length}
              moveUpLabel={t("moveUp")}
              moveDownLabel={t("moveDown")}
              onText={onText}
              onCaption={onCaption}
              onMove={onMove}
              onRemove={onRemove}
            />
          ))}
        </ul>

        <div className="hxw-add-row">
          <button type="button" className="hxw-btn" onClick={() => changeBlocks((blocks) => [...blocks, { id: newId(), kind: "text", text: "" }])}>
            {t("addText")}
          </button>
          <button type="button" className="hxw-btn" disabled={busy} onClick={() => fileInput.current?.click()}>
            {t("addImage")}
          </button>
          <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(event) => void addImages(imageFilesFrom(event.target.files))} />
        </div>
        <p className="hxw-muted hxw-cv-hint">{t("dropHint")}</p>
      </div>

      {dragging ? <div className="hxw-drop">{t("dropHint")}</div> : null}
      {/* A conflict is a decision, so it follows the user into this column too.
          A confirmation is raised from the panel's own controls and stays there:
          repeating it here would show the same question twice on one screen. */}
      {snapshot.notice?.follows ? <NoticeBar notice={snapshot.notice} /> : null}
    </section>
  );
}

/** The tab chip: the card's own title, so a strip of tabs stays readable. */
export function CardTabTitle({ cardId, t }: { cardId?: string; t: Translate }) {
  const snapshot = useWorks();
  const card = snapshot.doc?.cards.find((item) => item.id === cardId) ?? null;
  return <span className="hxw-chip-title">{card?.title?.trim() || t("titlePlaceholder")}</span>;
}

/* ------------------------------------------------------------------ *
 * Styles — every colour is a theme token, so a theme switch restyles the card
 * ------------------------------------------------------------------ */

const CARD_CSS = `
.hxw-cv{--hxw-accent:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));--hxw-accent-soft:color-mix(in srgb,var(--hxw-accent) 14%,transparent);--hxw-accent-line:color-mix(in srgb,var(--hxw-accent) 42%,transparent);--hxw-card:var(--dsw-alias-bg-layer-1);--hxw-card-2:var(--dsw-alias-bg-layer-2);--hxw-border:var(--dsw-alias-border-l1);--hxw-border-2:var(--dsw-alias-border-l2);--hxw-text:var(--dsw-alias-label-primary);--hxw-text-2:var(--dsw-alias-label-secondary);--hxw-text-3:var(--dsw-alias-label-tertiary);--hxw-hover:var(--dsw-alias-interactive-bg-hover);--hxw-danger:var(--dsw-alias-state-error-primary,#dc2626);position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--hxw-text);font-size:13.5px;line-height:1.65}
.hxw-cv *,.hxw-cv *::before,.hxw-cv *::after{box-sizing:border-box}
.hxw-cv button{font:inherit;color:inherit}
.hxw-cv-head{flex:none;padding:10px 12px 7px;border-bottom:1px solid var(--hxw-border)}
.hxw-cv-title{display:block;width:100%;border:0;background:0 0;color:var(--hxw-text);font:inherit;font-size:15.5px;font-weight:650;line-height:1.4;resize:none;overflow:hidden;padding:0}
.hxw-cv-title::placeholder{color:var(--hxw-text-3)}
.hxw-cv-title:focus-visible{outline:none}
.hxw-cv-meta{display:flex;align-items:center;gap:8px;margin-top:2px;color:var(--hxw-text-3);font-size:11.5px}
.hxw-save{margin-left:auto;white-space:nowrap}
.hxw-save[data-state=saving]{color:var(--hxw-text-3)}
.hxw-save[data-state=saved]{color:var(--dsw-alias-state-success-primary,#16a34a)}
.hxw-save[data-state=error]{color:var(--hxw-danger)}
.hxw-cv-body{flex:1;min-height:0;overflow:auto;padding:9px 12px 32px}
.hxw-cv-empty{display:grid;place-items:center}
.hxw-cv-hint{text-align:center}
.hxw-cv-collected{display:inline-flex;align-items:center;gap:4px;color:var(--hxw-text-3)}
.hxw-cv-collected input{border:0;background:0 0;color:var(--hxw-text-2);font:inherit;font-size:11.5px;padding:0;cursor:pointer;color-scheme:light}
.hxw-cv-collected input:hover{color:var(--hxw-text)}
.hxw-cv-collected input:focus-visible{outline:none;color:var(--hxw-text)}
body[data-ds-dark-theme] .hxw-cv-collected input{color-scheme:dark}
/* 来源: an optional detail, so it is a glyph rather than a field. It sits beside
   the collected date at the date's own weight, and only a card that carries a
   source shows the accent — the icon is the whole footprint at rest. */
.hxw-src-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:0 0;color:var(--hxw-text-3);cursor:pointer;transition:background .14s,color .14s}
.hxw-src-btn>svg{display:block;width:13px;height:13px}
.hxw-src-btn:hover{background:var(--hxw-hover);color:var(--hxw-text)}
.hxw-src-btn[data-on=true]{color:var(--hxw-accent)}
.hxw-src-btn[data-open=true]{background:var(--hxw-accent-soft);color:var(--hxw-accent)}
.hxw-src-btn:focus-visible{outline:2px solid var(--hxw-accent);outline-offset:1px}
.hxw-source-input{display:block;width:100%;margin-top:6px;border:1px solid var(--hxw-border-2);border-radius:8px;background:var(--hxw-card);color:var(--hxw-text);padding:4px 8px;font:inherit;font-size:12px}
.hxw-source-input::placeholder{color:var(--hxw-text-3)}
.hxw-source-input:focus-visible{outline:none;border-color:var(--hxw-accent);box-shadow:0 0 0 3px var(--hxw-accent-soft)}
.hxw-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--hxw-border-2);border-radius:8px;background:var(--hxw-card);color:var(--hxw-text-2);padding:5px 10px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.hxw-btn:hover:not(:disabled){background:var(--hxw-hover);border-color:var(--hxw-accent-line);color:var(--hxw-text)}
.hxw-btn:focus-visible{outline:2px solid var(--hxw-accent);outline-offset:1px}
.hxw-btn:disabled{opacity:.5;cursor:not-allowed}
.hxw-field{display:flex;align-items:flex-start;gap:7px;margin-bottom:7px}
.hxw-field>label{flex:none;width:34px;padding-top:5px;color:var(--hxw-text-3);font-size:11.5px}
.hxw-tag-picker{display:flex;flex-wrap:wrap;gap:5px;flex:1;min-width:0;align-items:center}
.hxw-chip-btn{border:1px solid var(--hxw-border);border-radius:999px;background:0 0;padding:2px 9px;font-size:12px;cursor:pointer;color:var(--hxw-text-2)}
.hxw-chip-btn:hover{border-color:var(--hxw-accent-line);color:var(--hxw-text)}
.hxw-chip-btn[data-on=true]{background:var(--hxw-accent-soft);border-color:var(--hxw-accent-line);color:var(--hxw-accent)}
.hxw-chip-add{border:1px dashed var(--hxw-border-2);border-radius:999px;background:0 0;color:var(--hxw-text);padding:2px 9px;font:inherit;font-size:12px;width:8em}
.hxw-chip-add:focus-visible{outline:none;border-color:var(--hxw-accent)}
.hxw-blocks{list-style:none;margin:9px 0 0;padding:0;display:flex;flex-direction:column;gap:2px}
.hxw-block{display:flex;align-items:flex-start;gap:6px;border-radius:10px;padding:2px 2px 2px 0;position:relative}
.hxw-block:hover{background:color-mix(in srgb,var(--hxw-hover) 60%,transparent)}
.hxw-block-gutter{flex:none;width:18px;padding-top:7px;text-align:right}
/* The number is a reference, not content: it surfaces when the row is under the
   pointer. The gutter keeps its width, so nothing shifts as it fades in. */
.hxw-block-index{color:var(--hxw-text-3);font-size:10.5px;font-variant-numeric:tabular-nums;opacity:0;transition:opacity .12s}
.hxw-block:hover .hxw-block-index,.hxw-block:focus-within .hxw-block-index{opacity:1}
.hxw-block-body{flex:1;min-width:0}
.hxw-text-block{display:block;width:100%;border:0;background:0 0;color:var(--hxw-text);font:inherit;resize:none;overflow:hidden;padding:5px 3px;min-height:30px}
.hxw-text-block:focus-visible{outline:none;background:var(--hxw-card);border-radius:8px;box-shadow:0 0 0 1px var(--hxw-border-2)}
.hxw-figure{margin:6px 0}
.hxw-image{display:block;max-width:100%;height:auto;border-radius:14px;border:1px solid var(--hxw-border);background:var(--hxw-card-2)}
.hxw-image-missing{display:grid;place-items:center;height:110px;border-radius:14px;border:1px dashed var(--hxw-border-2);background:var(--hxw-card-2);color:var(--hxw-text-3);font-size:20px}
.hxw-caption{width:100%;border:0;background:0 0;color:var(--hxw-text-2);font:inherit;font-size:12px;padding:4px 3px 2px}
.hxw-caption::placeholder{color:transparent}
.hxw-caption:focus-visible{outline:none;color:var(--hxw-text)}
.hxw-block-tools{flex:none;display:flex;gap:1px;opacity:0;transition:opacity .12s;padding-top:3px}
.hxw-block:hover .hxw-block-tools,.hxw-block:focus-within .hxw-block-tools{opacity:1}
.hxw-block-tools button{border:0;background:0 0;color:var(--hxw-text-3);cursor:pointer;border-radius:6px;width:20px;height:20px;line-height:1;padding:0;font-size:11px;display:inline-flex;align-items:center;justify-content:center}
/* One arrow for both directions: "down" is the same glyph turned half a circle. */
.hxw-block-tools button svg{display:block;width:14px;height:14px}
.hxw-block-tools button svg[data-dir=down]{transform:rotate(180deg)}
.hxw-block-tools button:hover:not(:disabled){background:var(--hxw-hover);color:var(--hxw-text)}
.hxw-block-tools button:disabled{opacity:.3;cursor:default}
.hxw-block-tools button.hxw-danger:hover{color:var(--hxw-danger)}
.hxw-add-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:9px;border-top:1px solid var(--hxw-border)}
.hxw-muted{color:var(--hxw-text-3);font-size:12px;margin:6px 0 0}
.hxw-empty{padding:24px 14px;color:var(--hxw-text-3);text-align:center}
.hxw-drop{position:absolute;inset:0;z-index:20;display:grid;place-items:center;border:2px dashed var(--hxw-accent);background:color-mix(in srgb,var(--dsw-alias-bg-base) 78%,transparent);color:var(--hxw-accent);font-weight:600;pointer-events:none}
.hxw-chip-title{display:inline-block;max-width:16em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
`;
