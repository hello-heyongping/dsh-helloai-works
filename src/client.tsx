/**
 * dsh-helloai-works — Client half.
 *
 * Three surfaces, one document:
 *   - the left sidebar row (below Plugins) that selects the central panel,
 *   - the central panel: tag rail + card list + the data/backups drawer,
 *   - a right-Sidebar tab type that shows one card, so reading and editing a
 *     card sits in the same column as the product's own file previews.
 *
 * Every colour is a `--dsw-*` theme token, so switching theme restyles the
 * whole feature without a single hard-coded brand colour.
 */
import * as React from "react";
import { CardView, CardTabTitle } from "./card-view.js";
import { CollectAction, CollectLayer } from "./collect.js";
import { createCardSource, cardPromptText, groupPromptText, cardSourceState, MAX_CARD_PROMPT_CHARS, MAX_GROUP_PROMPT_CHARS } from "./mention.js";
import type { TriggerService } from "./mention.js";
import { NoticeBar } from "./notice.js";
import { UNTAGGED, buildSearchIndex, excerpt, formatSize, formatTime, imageCount, message, planImage, searchCards, selectCards, useWorks, worksStore } from "./works-store.js";
import type { BackupRecord, Card, Tag, Translate } from "./works-store.js";

declare const __HELLOAI_WORKS_VERSION__: string;
const VERSION = typeof __HELLOAI_WORKS_VERSION__ === "string" ? __HELLOAI_WORKS_VERSION__ : "0.0.0";

const NS = "helloai-works";
/** Shared by the sidebar row and the main panel it opens. */
export const PANEL_ID = "helloai-works";
/** The right-Sidebar page type that shows one card. */
const CARD_TAB_ID = "@hello-heyongping/dsh-helloai-works/card";
const CARD_TAB_KIND = "helloaiWorksCard";

type ClientContext = {
  effect: (effect: () => void | (() => void), label?: string) => unknown;
  /** Cordis service lookup; the trigger pipeline is read through this. */
  get: (name: string) => unknown;
  /**
   * Cordis dependency injection: the callback runs in a child context once
   * every named service exists (immediately when it already does), so a service
   * from a sibling client package never has to be timed or guessed at.
   */
  inject: (dependencies: string[], callback: (ctx: ClientContext) => void) => unknown;
  locale: {
    register: (namespace: string, dictionary: Record<string, Record<string, string>>) => () => void;
    bind: (namespace: string) => Translate;
  };
  slots: {
    inject: (name: string, factory: () => unknown) => unknown;
    register: (options: Record<string, unknown>, component: React.ComponentType<any>) => unknown;
  };
  sidebarRight: { openTab: (kind: string, options?: { params?: Record<string, unknown> }) => unknown };
  sidebarRightTabs: { register: (definition: Record<string, unknown>) => () => void };
};

/** Tab id → card id, so a tab restored from layout storage still shows its card. */
const tabBindings = new Map<string, string>();

const DICT = {
  zh: {
    panel: "卡片资料",
    title: "卡片资料",
    subtitle: "以标签分类，卡片记录图文，对话可@卡片和标签分组",
    search: "搜索标题、正文或标签…",
    all: "全部",
    untagged: "未分类",
    tags: "标签",
    newTag: "新建标签",
    renameTag: "重命名标签",
    renameTagHint: "双击重命名",
    mentionSection: "卡片资料",
    mentionTagSection: "标签分组",
    mentionTagRows: "{count} 张卡片 · 整组引用",
    mentionCardHead: "【卡片资料：{title}】",
    mentionTags: "标签：{names}",
    mentionSource: "来源：{source}",
    mentionCollected: "收集于：{date}",
    mentionImage: "［图片：{caption}］",
    mentionImageBare: "［图片］",
    mentionTruncated: "……（卡片较长，此处截断；全文共 {total} 字）",
    mentionGroupHead: "【卡片资料：标签「{name}」共 {count} 张卡片】",
    mentionGroupEmpty: "【卡片资料：标签「{name}」下还没有卡片】",
    mentionGroupTruncated: "（为控制长度，只带了前 {included} 张，另有 {omitted} 张未展开；需要的话单独 @ 那几张）",
    mentionCardGone: "【卡片资料：引用的卡片已不存在（{id}）】",
    mentionTagGone: "【卡片资料：引用的标签已不存在（{id}）】",
    mentionHintOff: "本会话的 @ 引用未接入（触发器服务不可用），其余功能不受影响",
    deleteTag: "删除标签",
    tagNameEmpty: "标签名不能为空。",
    tagMerged: "该名称已存在，已合并到那个标签。",
    tagDeleted: "已删除标签：{name}",
    confirmDeleteTag: "删除标签“{name}”？卡片本身会保留，只是不再带这个标签。",
    newCard: "新建",
    backupLabel: "备份",
    noCards: "这个分类里还没有卡片",
    noCardsHint: "点“新建”开始记录，图片可以直接粘贴或拖进来。",
    cardCount: "{count} 张",
    sortNewest: "最新在前",
    sortOldest: "最早在前",
    collected: "收集于",
    images: "{count} 张图",
    openInSidebar: "《{name}》已在右侧栏打开。",
    openHint: "点左侧任意一张卡片，就在右侧栏里查看和编辑。",
    titlePlaceholder: "标题",
    untitled: "未命名",
    cardGone: "这张卡片已被删除。",
    source: "来源",
    sourcePlaceholder: "链接、书名或出处（可留空）",
    addText: "＋ 文字",
    addImage: "＋ 图片",
    moveUp: "上移",
    moveDown: "下移",
    deleteCard: "删除卡片",
    duplicateCard: "复制卡片",
    copySuffix: "（副本）",
    cardDeleted: "已删除卡片：{name}",
    cardDuplicated: "已复制为新卡片。",
    confirmDeleteCard: "删除卡片“{name}”？删除后可以在备份里找回。",
    save: "保存",
    saving: "保存中…",
    saved: "已保存 {time}",
    saveFailed: "保存失败",
    conflictText: "这份资料在别处也被改过：磁盘上现在是 {cards} 张卡片（版本 {revision}，{time}）。你的改动还没有保存。",
    conflictKeepMine: "用我的改动覆盖",
    conflictTakeTheirs: "放弃我的改动",
    conflictKeptMine: "已用你的改动覆盖磁盘版本。",
    conflictTookTheirs: "已载入磁盘版本，你的改动已丢弃。",
    export: "生成完整备份",
    importing: "正在导入…",
    importFile: "导入备份",
    importDone: "已导入 {cards} 张卡片、{assets} 张图片。",
    confirmImport: "导入会用备份文件替换当前的卡片资料（导入前会自动存一份快照）。确定继续吗？",
    invalidFile: "请选择由本插件导出的 .json 备份文件。",
    dataTitle: "数据与备份",
    storage: "存储位置",
    document: "文档",
    close: "关闭",
    cancel: "取消",
    refresh: "刷新",
    backups: "备份文件",
    backupsEmpty: "还没有备份文件。每次保存都会自动生成一份快照。",
    kindSnapshot: "快照",
    kindFull: "完整",
    restore: "恢复",
    confirmRestore: "用这份备份覆盖当前的卡片资料？当前内容会先自动存成一份快照。",
    restoreDone: "已恢复：{cards} 张卡片、{assets} 张图片。",
    deleteBackup: "删除备份",
    confirmDeleteBackup: "删除备份文件 {name}？删除后无法恢复。",
    backupDeleted: "已删除备份 {name}。",
    download: "下载",
    collect: "清理未引用图片",
    confirmCollect: "删除没有被任何卡片引用的图片文件？旧的“快照”备份可能因此缺失图片，但“完整”备份是自包含的，不受影响。",
    collectDone: "已清理 {removed} 张图片，释放 {size}。",
    collectNothing: "没有未引用的图片。",
    exported: "已生成备份文件：{name}（{size}）。文件同时保存在 {path}，可直接点“下载”。",
    exporting: "正在打包图片…",
    storageHint: "整个资料库就是磁盘上的一个文件夹，可以直接复制或用网盘同步。",
    helpHint: "数据存在哪、图片怎么存、完整备份包含什么、卸载后怎么恢复——都在下面「数据说明」里。",
    helpTitle: "数据说明：存在哪、怎么保护、怎么恢复",
    helpWhere: "① 数据存在哪",
    helpWhereBody:
      "整个资料库就是 DSH_HOME 下的一个普通文件夹（上面「存储位置」是它的真实路径，默认 C:\\Users\\<用户名>\\.dsh\\helloai-works）：\n" +
      "works.json　标签 + 全部卡片（标题、来源、正文、图片引用、时间）\n" +
      "assets/　　每一张图片，文件名就是图片内容的 SHA-1\n" +
      "backups/　 自动快照 + 完整备份\n" +
      "它不依赖本插件：可以整个文件夹复制、放网盘同步，甚至丢进 Git。",
    helpImages: "② 图片怎么存",
    helpImagesBody:
      "粘贴、拖入或选择进来的图片会先在浏览器里处理好，再存成 assets/ 下的独立文件：\n" +
      "· 按内容命名（SHA-1），同一张图插入多少次也只存一份；\n" +
      "· 库里保存的是副本，删掉电脑上的原图不影响任何卡片；\n" +
      "· 在插件里删卡片或图片块也不会立刻删图片文件，只有点「清理未引用图片」才会删掉没有任何卡片引用的图片；\n" +
      "· 图片不进 works.json，所以文档一直是 KB 级，加图不用重写整份资料。",
    helpCompress: "③ 插图时的压缩规则",
    helpCompressBody:
      "· 宽度超过 1500 px：等比缩小到宽 1500 px（高度按同一比例缩）；\n" +
      "· 宽度没超过 1500 px：一个字节都不动，不重新编码、不掉画质；\n" +
      "· 需要缩小时，PNG 仍然是 PNG（透明通道保留），WebP 仍然是 WebP；JPEG / BMP / AVIF 另存为 JPEG（质量 0.88）；\n" +
      "· GIF 动图和 SVG 原样保留，不重新编码；单张图片上限 32 MB。",
    helpFull: "④ 完整备份和快照分别备份了什么",
    helpFullBody:
      "「生成完整备份」产出 works-full-<时间>.json：一个自包含文件，既有全部卡片（标题、正文、标签、来源、时间），也有每张被引用图片的 base64 数据——图文都在同一个文件里，拷到别的电脑上「导入备份」就能用。\n" +
      "自动快照 works-<时间>.json 只含卡片文字、不含图片字节（图片仍从当前 assets/ 读取）。所以快照适合「改错了回退」，要搬走或长期保存请用完整备份。",
    helpUninstall: "⑤ 卸载 DeepSeek Harness 后数据还在吗",
    helpUninstallBody:
      "在。数据在用户目录（DSH_HOME，默认 C:\\Users\\<用户名>\\.dsh）里，和程序安装目录无关。卸载 DeepSeek Harness 只会删掉程序本身，不会动 helloai-works 文件夹——除非你手动删除，或用清理软件删掉了整个 .dsh。",
    helpRestore: "⑥ 怎么恢复",
    helpRestoreBody:
      "· 重装 DSH 和本插件：同一个 DSH_HOME，文件夹还在，打开就是原样；\n" +
      "· 换了电脑或数据被删：把之前下载出去的 works-full-<时间>.json 用「导入备份」导回来（导入前会自动先存一份快照）；\n" +
      "· 只要 helloai-works 文件夹还在（哪怕一份备份文件都没有），直接拷回 DSH_HOME 就能用，插件不需要任何登记。",
    helpProtect: "⑦ 保护好数据：五条建议",
    helpProtectBody:
      "1. 定期「生成完整备份」再点「下载」，把它存到另一个盘、U 盘或网盘——只留在 backups/ 里，磁盘坏了会一起没；\n" +
      "2. 整个 helloai-works 文件夹可以直接用网盘同步，等于随身带一份副本；\n" +
      "3. 别把「清理未引用图片」当日常操作：它会让旧快照缺图，清理前先做一次完整备份；\n" +
      "4. 自动快照只保留最近 30 份、且只含文字，重要的时间点自己导一份完整备份；\n" +
      "5. 卸载、重装或换电脑之前，先导一次完整备份。",
    versionLabel: "插件版本 · 构建时取自 package.json",
    networkFailed: "连接不上资料服务：插件可能正在重新加载，请稍后重试；若一直失败请重启 DeepSeek Harness。",
    loadFailed: "读取资料失败",
    dropHint: "可以粘贴或拖入图片",
    imageTooLarge: "图片太大，无法保存：{name}",
    imagesAdded: "已加入 {count} 张图片。",
    collectAction: "加入到卡片资料",
    collectTitle: "加入到卡片资料",
    collectFieldTitle: "标题",
    collectFieldBody: "内容",
    collectSaved: "已添加到卡片资料：{name}",
    collectStale: "资料还没载入完成，请稍后重试。",
    collectNoText: "没有读到文字，可以直接在这里输入。",
    collectNewTagHint: "新标签，保存时才创建；点一下可以取消选择",
  },
  en: {
    panel: "Works",
    title: "Works",
    subtitle: "Cards filed by tag, holding text and images; a chat can @ cards and tag groups.",
    search: "Search title, body or tag…",
    all: "All",
    untagged: "Untagged",
    tags: "Tags",
    newTag: "New tag",
    renameTag: "Rename tag",
    renameTagHint: "Double-click to rename",
    mentionSection: "Cards",
    mentionTagSection: "Tag groups",
    mentionTagRows: "{count} cards · pull the whole group",
    mentionCardHead: "[Works card: {title}]",
    mentionTags: "Tags: {names}",
    mentionSource: "Source: {source}",
    mentionCollected: "Collected: {date}",
    mentionImage: "[image: {caption}]",
    mentionImageBare: "[image]",
    mentionTruncated: "…(card truncated here; {total} characters in all)",
    mentionGroupHead: "[Works cards: tag “{name}”, {count} cards]",
    mentionGroupEmpty: "[Works card: nothing is filed under the tag “{name}” yet]",
    mentionGroupTruncated: "(Only the first {included} cards fit; {omitted} more were left out — reference them one by one if you need them.)",
    mentionCardGone: "[Works card: the referenced card no longer exists ({id})]",
    mentionTagGone: "[Works card: the referenced tag no longer exists ({id})]",
    mentionHintOff: "@ references are off in this session (no trigger pipeline); everything else works",
    deleteTag: "Delete tag",
    tagNameEmpty: "A tag needs a name.",
    tagMerged: "That name already exists — merged into it.",
    tagDeleted: "Deleted tag: {name}",
    confirmDeleteTag: "Delete the tag “{name}”? The cards stay; they just lose this tag.",
    newCard: "New",
    backupLabel: "Backup",
    noCards: "No cards in this category yet",
    noCardsHint: "Press “New” to start; images can be pasted or dropped right in.",
    cardCount: "{count} cards",
    sortNewest: "Newest first",
    sortOldest: "Oldest first",
    collected: "Collected",
    images: "{count} images",
    openInSidebar: "“{name}” is open in the right sidebar.",
    openHint: "Pick any card on the left to read and edit it in the right sidebar.",
    titlePlaceholder: "Title",
    untitled: "Untitled",
    cardGone: "This card has been deleted.",
    source: "Source",
    sourcePlaceholder: "Link, book title or origin (optional)",
    addText: "＋ Text",
    addImage: "＋ Image",
    moveUp: "Move up",
    moveDown: "Move down",
    deleteCard: "Delete card",
    duplicateCard: "Duplicate card",
    copySuffix: " (copy)",
    cardDeleted: "Deleted card: {name}",
    cardDuplicated: "Duplicated as a new card.",
    confirmDeleteCard: "Delete the card “{name}”? You can still recover it from a backup.",
    save: "Save",
    saving: "Saving…",
    saved: "Saved {time}",
    saveFailed: "Save failed",
    conflictText: "This collection also changed elsewhere: the stored copy now holds {cards} cards (revision {revision}, {time}). Your edits are not saved yet.",
    conflictKeepMine: "Keep my version",
    conflictTakeTheirs: "Discard my edits",
    conflictKeptMine: "Your edits replaced the stored version.",
    conflictTookTheirs: "Loaded the stored version; your edits were discarded.",
    export: "Build full backup",
    importing: "Importing…",
    importFile: "Import backup",
    importDone: "Imported {cards} cards and {assets} images.",
    confirmImport: "Importing replaces the current collection with the backup (a snapshot is taken first). Continue?",
    invalidFile: "Please choose a .json backup produced by this plugin.",
    dataTitle: "Data & backups",
    storage: "Storage",
    document: "Document",
    close: "Close",
    cancel: "Cancel",
    refresh: "Refresh",
    backups: "Backup files",
    backupsEmpty: "No backup files yet. Every save writes a snapshot automatically.",
    kindSnapshot: "Snapshot",
    kindFull: "Full",
    restore: "Restore",
    confirmRestore: "Overwrite the current collection with this backup? The current content is snapshotted first.",
    restoreDone: "Restored {cards} cards and {assets} images.",
    deleteBackup: "Delete backup",
    confirmDeleteBackup: "Delete the backup file {name}? This cannot be undone.",
    backupDeleted: "Deleted the backup {name}.",
    download: "Download",
    collect: "Collect unused images",
    confirmCollect: "Delete image files no card references? Older “snapshot” backups may then miss those pictures, but “full” backups are self-contained and unaffected.",
    collectDone: "Removed {removed} images, freeing {size}.",
    collectNothing: "No unused images.",
    exported: "Backup written: {name} ({size}). It is on disk at {path} — use Download to copy it out.",
    exporting: "Packing images…",
    storageHint: "The whole collection is one folder on disk — copy it or sync it with any cloud drive.",
    helpHint: "Where the data lives, how pictures are stored, what a full backup holds and how to recover after an uninstall — all in “About your data” below.",
    helpTitle: "About your data: where it lives, how to keep it safe",
    helpWhere: "① Where the data lives",
    helpWhereBody:
      "The whole collection is one ordinary folder under DSH_HOME (the “Storage” path above is its real location; by default C:\\Users\\<you>\\.dsh\\helloai-works):\n" +
      "works.json　tags + every card (title, source, text, image references, times)\n" +
      "assets/　　one file per picture, named after the SHA-1 of its bytes\n" +
      "backups/　 automatic snapshots + full backups\n" +
      "Nothing here depends on this plugin: copy the folder, sync it with a cloud drive, even put it in Git.",
    helpImages: "② How pictures are stored",
    helpImagesBody:
      "A pasted, dropped or picked picture is prepared in the browser first, then stored as its own file under assets/:\n" +
      "· named by content (SHA-1), so the same picture is stored once however often it is inserted;\n" +
      "· the collection holds a copy — deleting the original file on your disk does not affect any card;\n" +
      "· deleting a card or an image block does not delete the file either; only “Collect unused images” removes pictures no card references any more;\n" +
      "· pictures are not inlined into works.json, so the document stays in the KB range and adding a picture never rewrites it.",
    helpCompress: "③ Compression when a picture is inserted",
    helpCompressBody:
      "· Wider than 1500 px: scaled down proportionally to 1500 px wide (the height follows the same ratio);\n" +
      "· 1500 px or narrower: not one byte is touched — no re-encoding, no loss of quality;\n" +
      "· when scaling does happen, PNG stays PNG (its transparency survives) and WebP stays WebP; JPEG / BMP / AVIF are re-encoded as JPEG (quality 0.88);\n" +
      "· animated GIF and SVG are stored as they are; one picture may be up to 32 MB.",
    helpFull: "④ What a full backup holds, and what a snapshot holds",
    helpFullBody:
      "“Build full backup” writes works-full-<time>.json: one self-contained file holding every card (title, body, tags, source, times) and the base64 bytes of every referenced picture — text and images in one file, ready to import on another machine.\n" +
      "An automatic snapshot works-<time>.json holds the cards only, with no image bytes (pictures keep coming from the current assets/). Snapshots are for “I edited this wrong, take me back”; to move the collection or keep it long-term, use a full backup.",
    helpUninstall: "⑤ Does the data survive uninstalling DeepSeek Harness?",
    helpUninstallBody:
      "Yes. It lives in your user folder (DSH_HOME, by default C:\\Users\\<you>\\.dsh), not in the application directory. Uninstalling DeepSeek Harness removes the program only and leaves helloai-works alone — unless you delete it yourself or a cleaner wipes the whole .dsh folder.",
    helpRestore: "⑥ How to recover",
    helpRestoreBody:
      "· Reinstall DSH and this plugin: same DSH_HOME, the folder is still there, and everything opens as before;\n" +
      "· Moved to another machine, or the data was deleted: import the works-full-<time>.json you downloaded earlier (a snapshot of the current state is taken first);\n" +
      "· As long as the helloai-works folder exists — even with no backup files at all — copy it back under DSH_HOME and it works; the plugin needs no registration step.",
    helpProtect: "⑦ Keeping it safe: five habits",
    helpProtectBody:
      "1. Build a full backup now and then and press Download, keeping the file on another drive, a USB stick or a cloud drive — inside backups/ alone it dies with the disk;\n" +
      "2. The helloai-works folder can simply be synced by a cloud drive, which gives you a second copy everywhere;\n" +
      "3. Do not treat “Collect unused images” as routine: it leaves older snapshots short of pictures, so build a full backup first;\n" +
      "4. Automatic snapshots keep the latest 30 and hold text only — export a full backup at the moments that matter;\n" +
      "5. Before uninstalling, reinstalling or changing computers, export a full backup.",
    versionLabel: "Plugin version · taken from package.json at build time",
    networkFailed: "Cannot reach the works service: the plugin may be reloading. Retry shortly, or restart DeepSeek Harness if it keeps failing.",
    loadFailed: "Could not load the collection",
    dropHint: "Paste or drop images here",
    imageTooLarge: "Image too large to store: {name}",
    imagesAdded: "Added {count} image(s).",
    collectAction: "Add to works",
    collectTitle: "Add to works",
    collectFieldTitle: "Title",
    collectFieldBody: "Content",
    collectSaved: "Added to works: {name}",
    collectStale: "The collection is still loading — try again in a moment.",
    collectNoText: "No text was read from this reply; type it here.",
    collectNewTagHint: "New tag — created on save; click to deselect",
  },
};

/* ------------------------------------------------------------------ *
 * Card-row icons
 *
 * Duplicate and delete are glyphs rather than words, so the row's tools stay
 * the same width in every language. Both are drawn with `currentColor`: the
 * button decides the hue (the theme's success and error states), which is what
 * keeps a green circle-plus and a red circle-x legible in either theme.
 * ------------------------------------------------------------------ */

function DuplicateIcon() {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M512 128a384 384 0 1 0 0 768 384 384 0 0 0 0-768z m0-85.333333c259.2 0 469.333333 210.133333 469.333333 469.333333s-210.133333 469.333333-469.333333 469.333333S42.666667 771.2 42.666667 512 252.8 42.666667 512 42.666667z"
      />
      <path fill="currentColor" d="M554.666667 469.333333h170.666666v85.333334h-170.666666v170.666666h-85.333334v-170.666666H298.666667v-85.333334h170.666666V298.666667h85.333334z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 1024 1024" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M835.919 836.467c-179.2 179.235-469.839 179.235-649.004 0-179.235-179.2-179.235-469.839 0-649.004 179.235-179.235 469.804-179.235 649.004 0 179.271 179.235 179.271 469.804 0 649.004z m-49.858-599.111c-168.572-168.642-414.897-134.426-549.252 0-168.642 168.607-134.426 414.861 0 549.252 168.607 165.358 414.861 134.462 549.252 0 165.358-165.288 134.462-414.861 0-549.252z m-166.418 436.93l-108.19-108.191-108.191 108.156-54.095-54.06L457.357 512l-108.19-108.191 54.095-54.096 108.191 108.192 108.191-108.191 54.06 54.095L565.548 512l108.156 108.191-54.06 54.096z"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Header action glyphs
 * The three buttons in the panel head carry a drawing instead of a text
 * character, so their weight no longer depends on which emoji font the
 * system happens to have. Every path is painted with `currentColor`: the
 * button keeps its own colour — label colour at rest, brighter under the
 * pointer — and the glyph follows for free. Each drawing carries its own
 * 16px box as well, so it stays a glyph even where the stylesheet cannot
 * reach it. `data-icon` names each one for the stylesheet and the
 * self-test.
 * ------------------------------------------------------------------ */

/** 新建 — a window with a plus: the card that is about to be created. */
function NewCardIcon() {
  return (
    <svg viewBox="0 0 1024 1024" width="16" height="16" data-icon="new" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M863.774118 898.951529c49.392941-0.481882 51.802353-38.068706 51.802353-66.800941v-367.435294c0-24.094118 10.24-42.164706 34.93647-42.164706 24.094118 0 34.334118 18.070588 34.334118 42.164706v379.482353c6.625882 66.319059-42.164706 120.470588-115.049412 120.470588H142.757647c-66.258824 0-121.072941-48.188235-121.072941-120.470588v-722.823529c0-66.258824 54.814118-120.410353 121.072941-120.410353h381.891765c24.094118 0 42.164706 10.179765 42.164706 34.334117 0 24.094118-18.070588 34.334118-42.164706 34.334118H142.757647c-49.392941 0-61.44 15.179294-61.44 51.802353v710.776471c0 47.043765 24.094118 66.740706 61.44 66.740705h721.016471zM734.870588 187.693176v-144.564705c0-24.094118 12.649412-42.164706 37.345883-42.164706 24.094118 0 37.345882 18.070588 37.345882 42.164706v144.564705h133.12c24.094118 0 42.164706 15.058824 42.164706 39.152942s-18.070588 39.152941-42.164706 39.152941h-133.12v126.494117c0 24.094118-13.251765 42.164706-37.345882 42.164706-24.696471 0-37.345882-18.070588-37.345883-42.164706v-132.517647H591.510588c-24.696471 0-42.767059-12.047059-42.767059-36.141176 0-23.853176 18.070588-35.900235 42.767059-36.141177h143.36z"
      />
    </svg>
  );
}

/** 备份 — stacked copies: every save also leaves a snapshot behind. */
function BackupIcon() {
  return (
    <svg viewBox="0 0 1024 1024" width="16" height="16" data-icon="backup" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M926.463125 457.775l-43.47187501-23.626875-50.23218749 24.8353125 71.7684375 39.065625c22.24875001 12.080625 30.4875 39.9140625 18.354375 62.109375-4.4765625 8.3240625-11.4609375 14.9915625-19.9228125 19.198125l-361.34531251 178.725a45.6534375 45.6534375 0 0 1-20.32687499 4.7859375 45.7725 45.7725 0 0 1-21.8915625-5.593125L119.560625 550.7159375C97.3540625 538.634375 89.11624999 510.8028125 101.204375 488.5625a45.845625 45.845625 0 0 1 19.9678125-19.15125001l69.170625-34.23468749-49.2478125-26.7571875-40.2928125 19.9125c-17.01375001 8.41125001-30.8025 21.65625001-39.845625 38.3475-24.17625001 44.3896875-7.700625 100.1475 36.7115625 124.3115625l379.78875 206.5115625c13.4325 7.2946875 28.5646875 11.19 43.8309375 11.19 14.060625 0 28.1165625-3.315 40.695-9.5334375l361.30125-178.725c17.0146875-8.4103125 30.8025-21.70125001 39.8915625-38.349375 24.1753125-44.3915625 7.700625-100.1446875-36.7125-124.3096875z"
      />
      <path
        fill="currentColor"
        d="M926.463125 641.06374999l-21.39937501-11.63343749-50.23218749 24.87843751 49.6959375 27.02906249c22.24875001 12.080625 30.4875 39.9140625 18.3984375 62.10843751-4.520625 8.3240625-11.5040625 14.9925-19.966875 19.19812499l-361.34531251 178.725a45.65625001 45.65625001 0 0 1-20.32687499 4.7878125 45.7753125 45.7753125 0 0 1-21.8915625-5.59593749L119.560625 734.005625c-22.2065625-12.080625-30.444375-39.915-18.35625-62.1553125a45.860625 45.860625 0 0 1 19.9678125-19.15125l47.09906251-23.3146875-49.20281251-26.76-18.26625 8.9953125c-17.01375001 8.4121875-30.8025 21.6571875-39.845625 38.3503125-24.17625001 44.3896875-7.700625 100.1446875 36.7115625 124.3096875l379.78875 206.51156251c13.4325 7.29375001 28.5646875 11.1890625 43.8309375 11.18906249 14.060625 0 28.1165625-3.3121875 40.695-9.5334375l361.30125-178.7240625c17.0146875-8.41125001 30.8025-21.7021875 39.8915625-38.349375 24.1753125-44.3896875 7.700625-100.1446875-36.7125-124.30968749z"
      />
      <path
        fill="currentColor"
        d="M502.8425 79.6971875c7.610625 0 15.178125 1.9246875 21.8915625 5.59406249l379.7925 206.55656251c22.2065625 12.039375 30.444375 39.961875 18.3984375 62.1571875-4.5646875 8.323125-11.461875 14.94375001-19.966875 19.15124999L541.6596875 551.879375a46.02375001 46.02375001 0 0 1-20.371875 4.7878125c-7.6096875 0-15.1771875-1.9678125-21.89156249-5.593125L119.560625 344.5175c-10.700625-5.8171875-18.5353125-15.5278125-21.9834375-27.29624999-3.49124999-11.7703125-2.1928125-24.12 3.6271875-34.85906251 4.5665625-8.323125 11.4609375-14.9465625 19.9678125-19.1540625L482.470625 84.485a46.0425 46.0425 0 0 1 20.371875-4.7878125m0-45.8221875c-14.0578125 0-28.1175 3.3103125-40.6959375 9.530625L100.80124999 222.1315625c-17.01375001 8.4121875-30.8025 21.6571875-39.84562499 38.3475-24.17625001 44.390625-7.700625 100.1475 36.7115625 124.3125l379.78875 206.5125c13.4325 7.2928125 28.5646875 11.18624999 43.8309375 11.18625 14.060625 0 28.1165625-3.3103125 40.695-9.530625l361.30125-178.7240625c17.0146875-8.4140625 30.8025-21.7021875 39.8915625-38.3503125 24.17625001-44.3896875 7.7015625-100.1465625-36.7115625-124.3096875L546.6284375 45.018125C533.2409375 37.7234375 518.1096875 33.875 502.8425 33.875z"
      />
    </svg>
  );
}

/** 保存 — the floppy: write the current collection to disk now. */
function SaveIcon() {
  return (
    <svg viewBox="0 0 1024 1024" width="16" height="16" data-icon="save" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M819.823 83.694H206.991c-67.703 0-122.588 54.885-122.588 122.588v612.833c0 67.703 54.885 122.588 122.588 122.588h612.833c67.703 0 122.588-54.885 122.588-122.588V206.282c-0.001-67.703-54.885-122.588-122.589-122.588z m-124.435 63.313v241.142H331.772V147.007h363.616z m185.787 672.274c0.027 33.765-27.323 61.158-61.088 61.185H207.133c-16.389 0-31.864-6.297-43.454-17.887s-18.039-26.91-18.039-43.298v-612.94c0.061-33.923 27.57-61.395 61.493-61.41h61.327v245.294c-0.05 33.771 27.286 61.187 61.057 61.237h367.888c33.853 0 61.299-27.387 61.299-61.237V144.931h61.206c33.872 0.036 61.301 27.524 61.265 61.396V819.281z"
      />
      <path
        fill="currentColor"
        d="M574.817 329.936c17.483 0 31.656-14.173 31.656-31.656v-61.292c0-17.483-14.173-31.656-31.656-31.656s-31.656 14.173-31.656 31.656v61.292c0 17.483 14.173 31.656 31.656 31.656z"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * Panel
 * ------------------------------------------------------------------ */

function WorksPanel({ t, openCard }: { t: Translate; openCard: (cardId: string) => void }) {
  const snapshot = useWorks();
  const [activeTag, setActiveTag] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [sortDesc, setSortDesc] = React.useState(true);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [newTagName, setNewTagName] = React.useState("");
  const [renamingTag, setRenamingTag] = React.useState<string | null>(null);

  React.useEffect(() => {
    worksStore.setTranslate(t);
    worksStore.start();
    return worksStore.installFlushOnHide();
  }, [t]);

  // The narrow layout hides the list while a card is hosted inline — the fallback
  // for when the right Sidebar refuses the tab. With no back control left in the
  // card, arriving at this panel is what returns the list to view. Deliberately
  // keyed to mount only: [t] changes identity often and would close the card mid-edit.
  React.useEffect(() => {
    worksStore.setInlineCard(null);
  }, []);

  const doc = snapshot.doc;
  const tags = doc?.tags ?? [];

  const counts = React.useMemo(() => {
    const map = new Map<string, number>();
    let untagged = 0;
    for (const item of doc?.cards ?? []) {
      if (!item.tags.length) untagged += 1;
      for (const tag of item.tags) map.set(tag, (map.get(tag) ?? 0) + 1);
    }
    return { map, untagged };
  }, [doc]);

  // Three steps with three different lifetimes, so a keystroke costs a scan and
  // nothing else: lower-casing follows the document, ordering follows the tag
  // rail and the sort toggle, and only the needle changes while typing.
  const searchIndex = React.useMemo(() => buildSearchIndex(doc), [doc]);
  const orderedCards = React.useMemo(() => selectCards(doc, { activeTag, sortDesc }), [doc, activeTag, sortDesc]);
  const visibleCards = React.useMemo(() => searchCards(orderedCards, query, searchIndex), [orderedCards, query, searchIndex]);

  const inlineCard = snapshot.inlineCardId ? (doc?.cards.find((item) => item.id === snapshot.inlineCardId) ?? null) : null;
  const openCardTitle = snapshot.activeCardId ? (doc?.cards.find((item) => item.id === snapshot.activeCardId)?.title ?? "") : "";

  /** Renaming onto an existing name merges the two; say which happened. */
  const commitRename = React.useCallback(
    (tagId: string, value: string) => {
      const result = worksStore.renameTag(tagId, value);
      setRenamingTag(null);
      if (result === "empty") worksStore.setNotice({ kind: "error", text: t("tagNameEmpty") });
      else if (result === "merged") worksStore.setNotice({ kind: "success", text: t("tagMerged") });
    },
    [t],
  );

  // Deleting a tag only unfiles its cards: the cards themselves stay.
  const removeTag = React.useCallback(
    (tag: Tag) => {
      worksStore.confirmDestructive({
        text: message(t, "confirmDeleteTag", { name: tag.name }),
        confirmLabel: t("deleteTag"),
        cancelLabel: t("cancel"),
        run: () => {
          worksStore.deleteTag(tag.id);
          if (activeTag === tag.id) setActiveTag(null);
          worksStore.setNotice({ kind: "success", text: message(t, "tagDeleted", { name: tag.name }) });
        },
      });
    },
    [t, activeTag],
  );

  const removeCard = React.useCallback(
    (item: Card) => {
      const name = item.title || t("untitled");
      worksStore.confirmDestructive({
        text: message(t, "confirmDeleteCard", { name }),
        confirmLabel: t("deleteCard"),
        cancelLabel: t("cancel"),
        run: () => {
          worksStore.deleteCard(item.id);
          worksStore.setNotice({ kind: "success", text: message(t, "cardDeleted", { name }) });
        },
      });
    },
    [t],
  );

  const duplicateCard = React.useCallback(
    (item: Card) => {
      const id = worksStore.duplicateCard(item.id, t("copySuffix"));
      if (!id) return;
      openCard(id);
      worksStore.setNotice({ kind: "success", text: t("cardDuplicated") });
    },
    [t, openCard],
  );

  return (
    <section className="hxw-root">
      <style>{PANEL_CSS}</style>

      <header className="hxw-head">
        {/* The family header is exactly two lines: brand + version, then what the
            panel does. Size and ink do the ranking, so the block stays short and
            the card list below keeps its height.
            Line two is one quiet sentence, and it names `@` as the way to pull
            cards into a chat. Whether `@` actually works is a fact about this
            session, not a setting, so the only thing that ever joins that
            sentence is the warning below — the one line a user can report back
            when the menu misbehaves. */}
        <div className="hxw-heading">
          <div className="hxw-head-row">
            <span className="hxw-kicker">HELLOAI | CARD RECORD</span>
            <span className="hxw-version" title={t("versionLabel")}>
              V{VERSION}
            </span>
          </div>
          <div className="hxw-head-row hxw-head-row-sub">
            <span className="hxw-subtitle">{t("subtitle")}</span>
            {cardSourceState.ready ? null : <span className="hxw-hint">{t("mentionHintOff")}</span>}
          </div>
        </div>
        <div className="hxw-actions">
          <input className="hxw-search" value={query} placeholder={t("search")} onChange={(event) => setQuery(event.target.value)} />
          <button type="button" className="hxw-btn" disabled={snapshot.loading} onClick={() => openCard(worksStore.createCard(activeTag))}>
            <NewCardIcon />
            <span>{t("newCard")}</span>
          </button>
          <button type="button" className="hxw-btn" onClick={() => setDrawerOpen((open) => !open)}>
            <BackupIcon />
            <span>{t("backupLabel")}</span>
          </button>
          <button type="button" className="hxw-btn" onClick={() => void worksStore.flush()}>
            <SaveIcon />
            <span>{t("save")}</span>
          </button>
        </div>
      </header>

      <div className="hxw-body" data-inline={inlineCard ? "true" : "false"}>
        <aside className="hxw-tags">
          <div className="hxw-side-title">{t("tags")}</div>
          <button type="button" className="hxw-tag-row" data-active={activeTag === null} onClick={() => setActiveTag(null)}>
            <span className="hxw-tag-name">{t("all")}</span>
            <span className="hxw-tag-count">{doc?.cards.length ?? 0}</span>
          </button>
          {counts.untagged > 0 ? (
            <button type="button" className="hxw-tag-row" data-active={activeTag === UNTAGGED} onClick={() => setActiveTag(UNTAGGED)}>
              <span className="hxw-tag-name">{t("untagged")}</span>
              <span className="hxw-tag-count">{counts.untagged}</span>
            </button>
          ) : null}
          {tags.map((tag) =>
            renamingTag === tag.id ? (
              <input
                key={tag.id}
                className="hxw-tag-input"
                autoFocus
                defaultValue={tag.name}
                onBlur={(event) => commitRename(tag.id, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitRename(tag.id, (event.target as HTMLInputElement).value);
                  if (event.key === "Escape") setRenamingTag(null);
                }}
              />
            ) : (
              <div key={tag.id} className="hxw-tag-row" data-active={activeTag === tag.id}>
                <button type="button" className="hxw-tag-name" title={t("renameTagHint")} onClick={() => setActiveTag(tag.id)} onDoubleClick={() => setRenamingTag(tag.id)}>
                  {tag.name}
                </button>
                <span className="hxw-tag-count">{counts.map.get(tag.id) ?? 0}</span>
                <span className="hxw-tag-tools">
                  <button type="button" title={t("renameTag")} onClick={() => setRenamingTag(tag.id)}>
                    ✎
                  </button>
                  <button type="button" className="hxw-danger" title={t("deleteTag")} onClick={() => removeTag(tag)}>
                    ✕
                  </button>
                </span>
              </div>
            ),
          )}
          <form
            className="hxw-tag-add"
            onSubmit={(event) => {
              event.preventDefault();
              worksStore.addTag(newTagName);
              setNewTagName("");
            }}
          >
            <input className="hxw-tag-input" value={newTagName} placeholder={`＋ ${t("newTag")}`} onChange={(event) => setNewTagName(event.target.value)} />
          </form>
        </aside>

        <div className="hxw-list">
          <div className="hxw-list-head">
            <span>{message(t, "cardCount", { count: visibleCards.length })}</span>
            <button type="button" className="hxw-link" onClick={() => setSortDesc((value) => !value)}>
              {sortDesc ? t("sortNewest") : t("sortOldest")}
            </button>
          </div>
          {snapshot.loading ? <div className="hxw-empty">…</div> : null}
          {!snapshot.loading && !visibleCards.length ? (
            <div className="hxw-empty">
              <div>{t("noCards")}</div>
              <p>{t("noCardsHint")}</p>
            </div>
          ) : null}
          <ul className="hxw-cards">
            {visibleCards.map((item) => (
              <li key={item.id}>
                <div className="hxw-card" data-active={item.id === snapshot.activeCardId}>
                  {/* The row is one big target; the tools sit above it, so no button nests a button. */}
                  <button type="button" className="hxw-card-open" aria-label={item.title || t("titlePlaceholder")} onClick={() => openCard(item.id)} />
                  <div className="hxw-card-body">
                    {/* Title and actions share one flex row, so the title stops exactly
                        where the icon buttons begin — no guessed reservation, any language. */}
                    <div className="hxw-card-top">
                      <span className="hxw-card-title">{item.title || t("titlePlaceholder")}</span>
                      <div className="hxw-card-tools">
                        <button
                          type="button"
                          className="hxw-icon-btn"
                          data-variant="copy"
                          title={t("duplicateCard")}
                          aria-label={t("duplicateCard")}
                          onClick={() => duplicateCard(item)}
                        >
                          <DuplicateIcon />
                        </button>
                        <button
                          type="button"
                          className="hxw-icon-btn"
                          data-variant="danger"
                          title={t("deleteCard")}
                          aria-label={t("deleteCard")}
                          onClick={() => removeCard(item)}
                        >
                          <DeleteIcon />
                        </button>
                      </div>
                    </div>
                    <span className="hxw-card-excerpt">{excerpt(item)}</span>
                    <span className="hxw-card-meta">
                      <span>{formatTime(item.createdAt)}</span>
                      {imageCount(item) ? <span className="hxw-chip">🖼 {imageCount(item)}</span> : null}
                      {item.tags.slice(0, 2).map((tagId) => (
                        <span key={tagId} className="hxw-chip">
                          {tags.find((tag) => tag.id === tagId)?.name ?? ""}
                        </span>
                      ))}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="hxw-side">
          {inlineCard ? (
            <CardView cardId={inlineCard.id} t={t} />
          ) : (
            <div className="hxw-empty hxw-empty-side">
              <div>{openCardTitle ? message(t, "openInSidebar", { name: openCardTitle }) : t("openHint")}</div>
            </div>
          )}
        </div>
      </div>

      {drawerOpen ? <DataDrawer t={t} onClose={() => setDrawerOpen(false)} /> : null}
      {snapshot.notice ? <NoticeBar notice={snapshot.notice} /> : null}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Data & backups drawer
 * ------------------------------------------------------------------ */

/**
 * The data guide, in reading order: where the collection lives, how a picture
 * is stored and compressed, what each kind of backup actually contains, what
 * happens to it when DeepSeek Harness is uninstalled, and how to get it back.
 *
 * Kept as key pairs rather than prose in the markup so a new language is one
 * dictionary edit, and so the self-test can assert the whole guide is wired up.
 */
const HELP: ReadonlyArray<readonly [term: string, body: string]> = [
  ["helpWhere", "helpWhereBody"],
  ["helpImages", "helpImagesBody"],
  ["helpCompress", "helpCompressBody"],
  ["helpFull", "helpFullBody"],
  ["helpUninstall", "helpUninstallBody"],
  ["helpRestore", "helpRestoreBody"],
  ["helpProtect", "helpProtectBody"],
];

function DataDrawer({ t, onClose }: { t: Translate; onClose: () => void }) {
  const snapshot = useWorks();
  const [listing, setListing] = React.useState<{ directory: string; records: BackupRecord[] } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const importInput = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    try {
      setListing(await worksStore.listBackups());
    } catch (error) {
      worksStore.setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const guard = async (task: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await task();
    } finally {
      setBusy(false);
    }
  };

  const onImport = (file: File | undefined) => {
    if (!file) return;
    // Clear the picker straight away: we already hold the File, and leaving the
    // name behind would make re-picking the same file fire no change event.
    if (importInput.current) importInput.current.value = "";
    if (!file.name.toLowerCase().endsWith(".json")) {
      worksStore.setNotice({ kind: "error", text: t("invalidFile") });
      return;
    }
    worksStore.confirmDestructive({
      text: t("confirmImport"),
      confirmLabel: t("importFile"),
      cancelLabel: t("cancel"),
      run: () => {
        void guard(async () => {
          try {
            await worksStore.importPayload(JSON.parse(await file.text()));
          } catch (error) {
            worksStore.setNotice({ kind: "error", text: error instanceof Error ? error.message : String(error) });
          }
        });
      },
    });
  };

  return (
    <div className="hxw-drawer">
      <div className="hxw-drawer-head">
        <h2>{t("dataTitle")}</h2>
        <button type="button" className="hxw-btn" onClick={onClose}>
          {t("close")}
        </button>
      </div>

      <div className="hxw-drawer-body">
        <div className="hxw-panel">
          <div className="hxw-side-title">{t("storage")}</div>
          <dl className="hxw-paths">
            <dt>{t("storage")}</dt>
            <dd>{snapshot.root || "…"}</dd>
            <dt>{t("document")}</dt>
            <dd>{snapshot.docPath || "…"}</dd>
          </dl>
          <p className="hxw-muted">{t("storageHint")}</p>
          {/* The guide is the part people need *before* they need it, so the
              panel points at it instead of hoping someone scrolls. */}
          <p className="hxw-muted">{t("helpHint")}</p>
        </div>

        <div className="hxw-panel">
          <div className="hxw-toolbar">
            <button type="button" className="hxw-btn hxw-primary" disabled={busy} onClick={() => void guard(async () => { await worksStore.exportBackup(); await load(); })}>
              ⬇ {t("export")}
            </button>
            <button type="button" className="hxw-btn" disabled={busy} onClick={() => importInput.current?.click()}>
              ⬆ {t("importFile")}
            </button>
            <input ref={importInput} type="file" accept="application/json,.json" hidden onChange={(event) => void onImport(event.target.files?.[0])} />
            <button
              type="button"
              className="hxw-btn hxw-ghost"
              disabled={busy}
              onClick={() => {
                worksStore.confirmDestructive({
                  text: t("confirmCollect"),
                  confirmLabel: t("collect"),
                  cancelLabel: t("cancel"),
                  run: () => {
                    void guard(async () => {
                      await worksStore.collectAssets();
                      await load();
                    });
                  },
                });
              }}
            >
              ⌫ {t("collect")}
            </button>
            <button type="button" className="hxw-btn hxw-ghost" onClick={() => void load()}>
              ⟳ {t("refresh")}
            </button>
          </div>
        </div>

        <div className="hxw-panel">
          <div className="hxw-side-title">{t("backups")}</div>
          {!listing || !listing.records.length ? (
            <p className="hxw-muted">{t("backupsEmpty")}</p>
          ) : (
            <ul className="hxw-backups">
              {listing.records.map((record) => (
                <li key={record.name}>
                  <div className="hxw-backup-main">
                    <span className="hxw-chip">{record.kind === "full" ? t("kindFull") : t("kindSnapshot")}</span>
                    <span className="hxw-backup-name">{record.name}</span>
                    <span className="hxw-muted hxw-backup-meta">
                      {formatSize(record.bytes)} · {formatTime(record.modifiedAt)}
                    </span>
                  </div>
                  <div className="hxw-backup-actions">
                    <button type="button" className="hxw-btn hxw-small" onClick={() => void worksStore.downloadBackup(record)}>
                      ⬇ {t("download")}
                    </button>
                    <button
                      type="button"
                      className="hxw-btn hxw-small"
                      disabled={busy}
                      onClick={() => {
                        worksStore.confirmDestructive({
                          text: t("confirmRestore"),
                          confirmLabel: t("restore"),
                          cancelLabel: t("cancel"),
                          run: () => {
                            void guard(async () => {
                              await worksStore.restoreBackup(record.name);
                              await load();
                            });
                          },
                        });
                      }}
                    >
                      ↩ {t("restore")}
                    </button>
                    <button
                      type="button"
                      className="hxw-btn hxw-small hxw-danger"
                      disabled={busy}
                      onClick={() => {
                        worksStore.confirmDestructive({
                          text: message(t, "confirmDeleteBackup", { name: record.name }),
                          confirmLabel: t("deleteBackup"),
                          cancelLabel: t("cancel"),
                          run: () => {
                            void guard(async () => {
                              await worksStore.deleteBackup(record.name);
                              await load();
                              worksStore.setNotice({ kind: "success", text: message(t, "backupDeleted", { name: record.name }) });
                            });
                          },
                        });
                      }}
                    >
                      🗑
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Open by default: this is the part that has to be read *before* the
            disk fails, and a collapsed block at the bottom is never read. */}
        <details className="hxw-help" open>
          <summary>{t("helpTitle")}</summary>
          <div className="hxw-help-body">
            {HELP.map(([term, body]) => (
              <div className="hxw-help-item" key={term}>
                <h3>{t(term)}</h3>
                <p>{t(body)}</p>
              </div>
            ))}
          </div>
        </details>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Right-Sidebar card tab
 * ------------------------------------------------------------------ */

type TabInfo = { tab: { id: string; navigation?: { params?: Record<string, unknown> } } };

/** Resolve which card a tab shows, surviving a reload that drops navigation params. */
function useTabCardId(tab: TabInfo["tab"] | undefined): string | undefined {
  const params = tab?.navigation?.params;
  const fromParams = params && typeof params.cardId === "string" ? params.cardId : undefined;
  if (tab && fromParams) tabBindings.set(tab.id, fromParams);
  return fromParams ?? (tab ? tabBindings.get(tab.id) : undefined);
}

function CardTabBody({ t, useTabInfo }: { t: Translate; useTabInfo: () => TabInfo }) {
  const { tab } = useTabInfo();
  const cardId = useTabCardId(tab);
  React.useEffect(() => {
    worksStore.start();
  }, []);
  if (!cardId) {
    return (
      <section className="hxw-cv hxw-cv-empty">
        <div className="hxw-empty">{t("openHint")}</div>
      </section>
    );
  }
  return <CardView cardId={cardId} t={t} />;
}

function CardTabChip({ t, useTabInfo }: { t: Translate; useTabInfo: () => TabInfo }) {
  const { tab } = useTabInfo();
  return <CardTabTitle cardId={useTabCardId(tab)} t={t} />;
}

/* ------------------------------------------------------------------ *
 * Styles for the panel — every colour is a theme token
 * ------------------------------------------------------------------ */

const PANEL_CSS = `
.hxw-root{--hxw-accent:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary,#4d6bfe));--hxw-accent-soft:color-mix(in srgb,var(--hxw-accent) 14%,transparent);--hxw-accent-line:color-mix(in srgb,var(--hxw-accent) 42%,transparent);--hxw-surface:var(--dsw-alias-bg-base);--hxw-card:var(--dsw-alias-bg-layer-1);--hxw-border:var(--dsw-alias-border-l1);--hxw-border-2:var(--dsw-alias-border-l2);--hxw-text:var(--dsw-alias-label-primary);--hxw-text-2:var(--dsw-alias-label-secondary);--hxw-text-3:var(--dsw-alias-label-tertiary);--hxw-hover:var(--dsw-alias-interactive-bg-hover);--hxw-danger:var(--dsw-alias-state-error-primary,#dc2626);--hxw-danger-soft:color-mix(in srgb,var(--hxw-danger) 18%,transparent);--hxw-success:var(--dsw-alias-state-success-primary,#16a34a);--hxw-success-soft:color-mix(in srgb,var(--hxw-success) 18%,transparent);position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--hxw-surface);color:var(--hxw-text);font-size:14px;line-height:1.6;container-type:inline-size}
.hxw-root *,.hxw-root *::before,.hxw-root *::after{box-sizing:border-box}
.hxw-root button{font:inherit;color:inherit}
.hxw-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex:none;padding:10px clamp(16px,2.4vw,28px) 9px;border-bottom:1px solid var(--hxw-border)}
/* The HelloAI family header is two lines, never more: brand + version badge,
   then one line of copy. Size and ink carry the ranking — the brand is the
   largest and darkest thing here, the copy below is a step smaller and the
   tertiary ink, so it reads as a caption and never competes with the cards.
   Namespace differs from the sibling plugins; the treatment is deliberately
   the same. */
.hxw-heading{display:flex;flex-direction:column;gap:2px;min-width:0}
.hxw-head-row{display:flex;align-items:baseline;flex-wrap:wrap;column-gap:7px;row-gap:1px;min-width:0}
.hxw-kicker{font-size:14px;font-weight:650;color:var(--hxw-text);letter-spacing:.05em;text-transform:uppercase;white-space:nowrap}
.hxw-head-row-sub{row-gap:2px;line-height:1.45}
.hxw-subtitle{color:var(--hxw-text-3);font-size:13px}
/* The @ status line: normally absent, because the standing sentence already
   names the feature. It appears only when the reference menu is not wired up,
   in the theme's warning ink — the one case a user needs to notice. */
.hxw-hint{font-size:12px;color:var(--hxw-danger)}
.hxw-version{align-self:center;flex:none;border:1px solid var(--hxw-accent-line);border-radius:999px;background:var(--hxw-accent-soft);color:var(--hxw-accent);font-size:10px;font-weight:700;letter-spacing:.06em;line-height:15px;padding:0 6px;font-variant-numeric:tabular-nums;white-space:nowrap}
.hxw-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;justify-content:flex-end}
.hxw-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--hxw-border-2);border-radius:9px;background:var(--hxw-card);color:var(--hxw-text-2);padding:7px 12px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.hxw-btn:hover:not(:disabled){background:var(--hxw-hover);border-color:var(--hxw-accent-line);color:var(--hxw-text)}
.hxw-btn:focus-visible{outline:2px solid var(--hxw-accent);outline-offset:1px}
.hxw-btn:disabled{opacity:.5;cursor:not-allowed}
.hxw-btn.hxw-primary{background:var(--hxw-accent);border-color:var(--hxw-accent);color:var(--dsw-alias-label-primary-foreground,#fff);font-weight:600}
.hxw-btn.hxw-primary:hover:not(:disabled){background:color-mix(in srgb,var(--hxw-accent) 86%,#000);border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.hxw-btn.hxw-ghost{background:transparent;border-color:transparent;color:var(--hxw-text-2)}
.hxw-btn.hxw-ghost:hover:not(:disabled){background:var(--hxw-hover);border-color:transparent}
.hxw-btn.hxw-danger{color:var(--hxw-danger);border-color:color-mix(in srgb,var(--hxw-danger) 40%,var(--hxw-border))}
.hxw-btn.hxw-danger:hover:not(:disabled){background:color-mix(in srgb,var(--hxw-danger) 14%,transparent);color:var(--hxw-danger)}
.hxw-btn.hxw-small{padding:4px 9px;font-size:12px;border-radius:7px}
/* The header actions draw their own glyph. Each <svg> carries width="16"
   height="16" itself, so the box survives even where this stylesheet cannot
   reach it — a <style> child rendered through react-dom/server escapes the ">"
   in a child selector, and an unsized viewBox would then fall back to 300x150.
   The rule below only pins the glyph as a non-shrinking flex item. */
.hxw-btn>svg{display:block;flex:none;width:16px;height:16px}
/* One standard for all three header actions: a bordered button with no fill, so
   新建 is no louder than 备份 and 保存. Hover is the only state that differs, and
   it comes from the shared .hxw-btn:hover rule above — the pointer is what turns
   the highlight on. */
.hxw-actions .hxw-btn{background:transparent}
.hxw-link{border:0;background:0 0;padding:0;cursor:pointer;color:var(--hxw-text-3);font-size:12px}
.hxw-link:hover{color:var(--hxw-accent)}
.hxw-search{width:min(240px,30vw);border:1px solid var(--hxw-border-2);border-radius:9px;background:var(--hxw-card);color:var(--hxw-text);padding:7px 11px;font:inherit}
.hxw-search::placeholder{color:var(--hxw-text-3)}
.hxw-search:focus-visible{outline:none;border-color:var(--hxw-accent);box-shadow:0 0 0 3px var(--hxw-accent-soft)}

.hxw-body{display:grid;grid-template-columns:186px minmax(240px,420px) minmax(0,1fr);flex:1;min-height:0;position:relative}
.hxw-tags{border-right:1px solid var(--hxw-border);overflow:auto;padding:12px 10px;display:flex;flex-direction:column;gap:2px}
.hxw-side-title{color:var(--hxw-text-3);font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;padding:0 6px 6px}
.hxw-tag-row{display:flex;align-items:center;gap:6px;width:100%;border:0;border-radius:8px;background:0 0;padding:6px 8px;cursor:pointer;text-align:left}
.hxw-tag-row:hover{background:var(--hxw-hover)}
.hxw-tag-row[data-active=true]{background:var(--hxw-accent-soft);color:var(--hxw-accent)}
.hxw-tag-row[data-active=true] .hxw-tag-count{color:var(--hxw-accent)}
.hxw-tag-name{flex:1;min-width:0;border:0;background:0 0;padding:0;cursor:pointer;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hxw-tag-count{flex:none;color:var(--hxw-text-3);font-size:12px;font-variant-numeric:tabular-nums}
/* Tag row actions stay visible at low opacity: a control nobody can find reads
   as a missing feature, which is exactly how rename/delete were being read. */
.hxw-tag-tools{flex:none;display:inline-flex;gap:1px;opacity:.4;transition:opacity .12s}
.hxw-tag-row:hover .hxw-tag-tools,.hxw-tag-row:focus-within .hxw-tag-tools{opacity:1}
.hxw-tag-tools button{border:0;background:0 0;color:var(--hxw-text-3);cursor:pointer;border-radius:6px;width:18px;height:18px;line-height:1;padding:0;font-size:10px}
.hxw-tag-tools button:hover{background:var(--hxw-hover);color:var(--hxw-text)}
.hxw-tag-tools button.hxw-danger:hover{color:var(--hxw-danger)}
.hxw-tag-input{width:100%;border:1px solid var(--hxw-border-2);border-radius:8px;background:var(--hxw-card);color:var(--hxw-text);padding:5px 8px;font:inherit;font-size:13px}
.hxw-tag-input:focus-visible{outline:none;border-color:var(--hxw-accent)}
.hxw-tag-add{margin-top:6px;padding:0 2px}
.hxw-list{border-right:1px solid var(--hxw-border);display:flex;flex-direction:column;min-height:0}
.hxw-list-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none;padding:10px 14px;border-bottom:1px solid var(--hxw-border);color:var(--hxw-text-3);font-size:12px}
.hxw-cards{list-style:none;margin:0;padding:8px;display:flex;flex-direction:column;gap:6px;overflow:auto;flex:1;min-height:0}
.hxw-card{position:relative;border:1px solid transparent;border-radius:10px;background:var(--hxw-card);padding:10px 12px;transition:background .12s,border-color .12s}
.hxw-card:hover{background:var(--hxw-hover)}
.hxw-card[data-active=true]{border-color:var(--hxw-accent-line);background:var(--hxw-accent-soft)}
.hxw-card-open{position:absolute;inset:0;z-index:1;border:0;background:0 0;padding:0;cursor:pointer;border-radius:inherit}
.hxw-card-open:focus-visible{outline:2px solid var(--hxw-accent);outline-offset:-2px}
.hxw-card-body{position:relative;z-index:2;display:flex;flex-direction:column;gap:4px;pointer-events:none}
.hxw-card-top{display:flex;align-items:center;gap:8px}
.hxw-card-title{flex:1;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hxw-card-excerpt{color:var(--hxw-text-2);font-size:12.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.hxw-card-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;color:var(--hxw-text-3);font-size:11.5px}
/* Round icon buttons: the glyph is the button, and the disc behind it only
   appears under the pointer. They sit a little quieter while the row is idle so
   a list of cards stays calm, then take the theme's own success and error tints
   on the row you are on. The pointer-events opt-in takes them back out of the
   body's click-through so they stay real buttons. */
.hxw-card-tools{flex:none;display:flex;align-items:center;gap:2px;pointer-events:auto}
.hxw-icon-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;padding:0;border:0;border-radius:50%;background:0 0;cursor:pointer;opacity:.75;transition:background .14s,color .14s,opacity .14s}
.hxw-icon-btn>svg{display:block;width:16px;height:16px}
.hxw-card:hover .hxw-icon-btn,.hxw-card:focus-within .hxw-icon-btn{opacity:1}
.hxw-icon-btn[data-variant=copy]{color:var(--hxw-success)}
.hxw-icon-btn[data-variant=danger]{color:var(--hxw-danger)}
.hxw-icon-btn[data-variant=copy]:hover{background:var(--hxw-success-soft)}
.hxw-icon-btn[data-variant=danger]:hover{background:var(--hxw-danger-soft)}
.hxw-icon-btn:active{transform:scale(.92)}
.hxw-icon-btn:focus-visible{outline:2px solid var(--hxw-accent);outline-offset:1px}
.hxw-chip{border:1px solid var(--hxw-border);border-radius:999px;padding:0 7px;line-height:16px;font-size:11px;color:var(--hxw-text-3);max-width:11em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hxw-side{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}
.hxw-side>.hxw-cv{flex:1;min-height:0}
.hxw-empty{padding:26px 16px;color:var(--hxw-text-3);text-align:center}
.hxw-empty p{margin:6px 0 0;font-size:12.5px}
.hxw-empty-side{margin:auto;max-width:32em}
.hxw-muted{color:var(--hxw-text-3);font-size:12.5px;margin:4px 0}

.hxw-drawer{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;background:var(--hxw-surface)}
.hxw-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:16px;flex:none;padding:16px clamp(16px,2.4vw,28px);border-bottom:1px solid var(--hxw-border)}
.hxw-drawer-head h2{margin:0;font-size:17px;font-weight:600}
.hxw-drawer-body{flex:1;min-height:0;overflow:auto;padding:16px clamp(16px,2.4vw,28px) 40px;display:flex;flex-direction:column;gap:12px}
.hxw-panel{border:1px solid var(--hxw-border);border-radius:12px;background:var(--hxw-card);padding:14px 16px}
.hxw-toolbar{display:flex;flex-wrap:wrap;gap:8px}
.hxw-paths{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 12px;margin:4px 0 8px;font-size:12.5px}
.hxw-paths dt{color:var(--hxw-text-3)}
.hxw-paths dd{margin:0;overflow-wrap:anywhere;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.hxw-backups{list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:6px}
.hxw-backups li{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border:1px solid var(--hxw-border);border-radius:9px;padding:8px 10px}
.hxw-backup-main{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.hxw-backup-name{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;overflow-wrap:anywhere}
.hxw-backup-meta{font-size:12px}
.hxw-backup-actions{display:flex;gap:6px}
/* The data guide: reference prose, so it is quiet, dense and scannable — each
   question is a heading over one paragraph, and the paragraph keeps its own
   line breaks (the numbered advice and the folder listing rely on them). */
.hxw-help{border:1px solid var(--hxw-border);border-radius:12px;background:var(--hxw-card);padding:12px 16px}
.hxw-help>summary{cursor:pointer;font-size:13px;font-weight:600;color:var(--hxw-text)}
.hxw-help>summary:hover{color:var(--hxw-accent)}
.hxw-help>summary:focus-visible{outline:2px solid var(--hxw-accent);outline-offset:2px;border-radius:6px}
.hxw-help-body{display:flex;flex-direction:column;gap:11px;margin-top:10px;padding-top:11px;border-top:1px solid var(--hxw-border)}
.hxw-help-item h3{margin:0 0 3px;font-size:12.5px;font-weight:600;color:var(--hxw-text)}
.hxw-help-item p{margin:0;color:var(--hxw-text-2);font-size:12.5px;line-height:1.75;white-space:pre-line;overflow-wrap:anywhere}

.hxw-notice-actions{display:flex;gap:6px;flex-wrap:wrap}

/* Narrow: fold the tag rail away, then let the fallback editor take the panel. */
@container (max-width:1080px){
.hxw-body{grid-template-columns:minmax(240px,1fr) minmax(0,1fr)}
.hxw-tags{display:none}
}
@container (max-width:760px){
.hxw-head{flex-direction:column;align-items:stretch}
.hxw-actions{justify-content:flex-start}
.hxw-search{width:100%}
.hxw-body{grid-template-columns:minmax(0,1fr)}
.hxw-list{border-right:0}
.hxw-body[data-inline=true] .hxw-list{display:none}
.hxw-body[data-inline=false] .hxw-side{display:none}
}
/* Very narrow: the heading keeps its two lines, so the actions give up their
   words instead of growing the header to a third row. */
@container (max-width:520px){
.hxw-actions{gap:6px}
.hxw-actions .hxw-btn{padding:6px 9px}
.hxw-actions .hxw-btn>span{display:none}
}
`;

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, DICT), "dsh-helloai-works locale");

  // Opening a card goes to the right Sidebar, beside the product's own previews.
  // Without a Session the surface refuses the tab, so the panel hosts the card.
  const openCard = (cardId: string): void => {
    worksStore.setActiveCard(cardId);
    try {
      ctx.sidebarRight.openTab(CARD_TAB_KIND, { params: { cardId } });
      worksStore.setInlineCard(null);
    } catch (error) {
      console.warn("[dsh-helloai-works] right sidebar is unavailable; editing inline", error);
      worksStore.setInlineCard(cardId);
    }
  };

  // `@` in the composer: cards join the shipped @file / @session menu as one
  // more list, and a picked card becomes a chip that expands to its own text
  // when the message is submitted.
  //
  // The pipeline belongs to a sibling client package, so it is looked up and,
  // failing that, injected — nothing else is touched, and nothing outside this
  // plugin's own panel is reached into. A DSH without the service simply never
  // attaches: only this feature is off, and the panel says so.
  let attached = false;
  const attachCardSource = (host: ClientContext): void => {
    if (attached) return;
    const triggers = typeof host.get === "function" ? (host.get("inputTriggers") as TriggerService | undefined) : undefined;
    if (typeof triggers?.registerSource !== "function") return;
    attached = true;
    host.effect(
      () => triggers.registerSource(createCardSource({ t: ctx.locale.bind(NS), openCard })),
      "dsh-helloai-works card reference source",
    );
    cardSourceState.ready = true;
  };
  attachCardSource(ctx);
  if (!attached && typeof ctx.inject === "function") ctx.inject(["inputTriggers"], attachCardSource);

  // The sidebar row, directly under the built-in Plugins entry (order 0).
  ctx.slots.inject("sidebar.panellist", () =>
    ctx.slots.register(
      { name: "sidebar.panellist", id: PANEL_ID, order: 1, locale: NS, label: () => ctx.locale.bind(NS)("panel") },
      WorksPanelIcon,
    ),
  );

  // The central page that row selects.
  ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: PANEL_ID, locale: NS, inject: () => ({ openCard }) }, WorksPanel));

  // Filing a reply: one icon in every finalized assistant message's action row,
  // beside the shipped copy, feedback and branch controls.
  ctx.slots.inject("conversation.chat.assistant-actions", () =>
    ctx.slots.register({ name: "conversation.chat.assistant-actions", id: "helloai-works-collect", order: 20, locale: NS }, CollectAction),
  );

  // Its draft dialog rides the frame-wide overlay: the conversation is not inside
  // the panel, so a panel-scoped overlay could not cover it.
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register({ name: "shell.overlay", id: "helloai-works-collect-dialog", order: 40, locale: NS }, CollectLayer),
  );

  // The card page type, its body and its chip title.
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: CARD_TAB_ID,
        kind: CARD_TAB_KIND,
        priority: "builtin",
        title: () => ctx.locale.bind(NS)("titlePlaceholder"),
      }),
    "dsh-helloai-works card tab type",
  );
  ctx.slots.inject("sidebar.right.pane.tab", () =>
    ctx.slots.register({ name: "sidebar.right.pane.tab", key: CARD_TAB_ID, locale: NS }, CardTabBody),
  );
  ctx.slots.inject("sidebar.right.pane.tab.title", () =>
    ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: CARD_TAB_ID, locale: NS }, CardTabChip),
  );
}

/** The sidebar glyph. Sized by the shell and coloured by the row's `currentColor`. */
function WorksPanelIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false" width={size} height={size}>
      <rect x="2.6" y="4.6" width="10.6" height="11.2" rx="2.2" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M6.4 4.6V3.2a1.4 1.4 0 0 1 1.4-1.4h8.2a1.4 1.4 0 0 1 1.4 1.4v8.2a1.4 1.4 0 0 1-1.4 1.4h-1.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M5.8 8.6h5.2M5.8 11.8h3.4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// `DataDrawer`, `planImage`, the reading helpers and the `@` source are exported
// alongside the store seam: the self-test and the benchmark drive them without a
// browser.
export { apply, NS, worksStore, DataDrawer, planImage, buildSearchIndex, selectCards, searchCards, UNTAGGED, createCardSource, cardPromptText, groupPromptText, cardSourceState, MAX_CARD_PROMPT_CHARS, MAX_GROUP_PROMPT_CHARS };
export const inject = ["slots", "locale", "sidebarRight", "sidebarRightTabs"];
