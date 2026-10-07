/**
 * 面板预览：用 jsdom 把 lib/client.js 里真实的「卡片资料」面板渲染出来（接口打桩），
 * 套上 DSH 的主题令牌后用无头 Chrome 截成 PNG，给 README 用真图。
 *
 * 运行：node scripts/preview-panel.mjs
 * 产物：%TEMP%/helloai-works-preview/panel-dark.png、panel-light.png（面板两张）
 *       card-open.png、card-open-light.png（右侧栏真开一张卡片的三张里多余那张）
 *       每张 PNG 旁边留一份同名 .html，方便人肉看排版。
 *
 * 「卡片打开」不是摆拍：走的是插件自己的 openCard → 右侧栏 slot 这条路。
 * 面板注册的 `main` 组件拿到的 openCard 就是 lib/client.js 里那个真函数，它调用
 * ctx.sidebarRight.openTab(kind, { params })；这里把 sidebarRight.openTab 记下来，
 * 再把注册到 `sidebar.right.pane.tab` 的 CardTabBody 用同一个 cardId 挂到面板右边
 * —— 也就是真 DSH 里「面板 + 右侧栏卡片」的版式。卡片正文里的图片同样不打桩成
 * 空框：把 API 的图片地址换成内联 SVG 占位图，截图里能看见真的图片块。
 *
 * 本插件保持零依赖：React / react-dom / jsdom 都从隔壁 dsh-helloai-bak 的
 * node_modules 借（createRequire），不在这里装 node_modules。
 * 需要本机有 Chrome/Chromium：默认依次尝试
 *   $DSH_PREVIEW_CHROME、Playwright 的 chromium-*、系统 Chrome。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const plugin = path.resolve(here, "..");
const workspace = path.resolve(plugin, "..");
// 角标版本与真实产物同源：预览页不写死版本号，免得和 package.json 漂移。
const { version } = JSON.parse(fs.readFileSync(path.join(plugin, "package.json"), "utf8"));
const deps = createRequire(path.join(workspace, "dsh-helloai-bak", "package.json"));
const React = deps("react");
const jsxRuntime = deps("react/jsx-runtime");
const { createRoot } = deps("react-dom/client");
const { JSDOM } = deps("jsdom");
/** 同一份 react/jsx-runtime 实例：面板和卡片两张子树共用，别让两份 React 打架。 */
const requireModule = (name) => (name === "react" ? React : name === "react/jsx-runtime" ? jsxRuntime : undefined);

const output = path.join(os.tmpdir(), "helloai-works-preview");
fs.mkdirSync(output, { recursive: true });

// 版式：面板本身是 flex 全高布局，容器宽度必须超过 1080px，否则 @container
// 会把左侧标签栏整个折掉（截图里就没有标签了）。高度也要给死，height:100% 才有参照。
const PANEL_WIDTH = 1200;
const PANEL_HEIGHT = 1080;
/** 打开卡片时右侧那一栏的宽度（真 DSH 的右侧栏更窄，这里给宽一点让卡片能看）。 */
const CARD_WIDTH = 440;
/** 面板和右侧栏之间的距离。 */
const COLUMN_GAP = 12;
const PAGE_PAD = 18;
const FRAME_WIDTH = PANEL_WIDTH + COLUMN_GAP + CARD_WIDTH;
const SHOT_SIZE = `${PANEL_WIDTH + PAGE_PAD * 2},${PANEL_HEIGHT + PAGE_PAD * 2}`;
const CARD_SHOT_SIZE = `${FRAME_WIDTH + PAGE_PAD * 2},${PANEL_HEIGHT + PAGE_PAD * 2}`;

function findChrome() {
  const candidates = [];
  if (process.env.DSH_PREVIEW_CHROME) candidates.push(process.env.DSH_PREVIEW_CHROME);
  const playwright = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  if (fs.existsSync(playwright)) {
    for (const entry of fs.readdirSync(playwright)) {
      if (!entry.startsWith("chromium")) continue;
      for (const nested of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
        candidates.push(path.join(playwright, entry, nested));
      }
    }
  }
  candidates.push("C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe");
  return candidates.find((candidate) => fs.existsSync(candidate));
}

// 1) 面板真实 CSS：产物里那份完整样式表（含末尾的 @container 收窄规则）。
// 只截到中间的某条规则会得到「像坏了」的裸排版，所以这里按模板字符串整体取，
// 并且校验取到的是整段（以 } 收尾、含容器查询），取不全就直接报错。
const bundle = fs.readFileSync(path.join(plugin, "lib", "client.js"), "utf8");
const cssAnchor = bundle.indexOf(".hxw-root{");
if (cssAnchor < 0) throw new Error("lib/client.js 里没有找到 .hxw-root 样式表，请先运行 node scripts/build.mjs");
const cssStart = bundle.lastIndexOf("`", cssAnchor);
const cssEnd = bundle.indexOf("`", cssAnchor);
if (cssStart < 0 || cssEnd < 0) throw new Error("lib/client.js 里样式表不是模板字符串，取不到完整 CSS");
const panelCss = bundle
  .slice(cssStart + 1, cssEnd)
  // CSS 注释里的 \uXXXX 转义在这里还原成汉字，纯粹为了好看
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
if (!panelCss.includes(".hxw-cards") || !panelCss.includes("@container") || !panelCss.trimEnd().endsWith("}")) {
  throw new Error(`面板 CSS 取到的不是完整样式表（${panelCss.length} 字符），请检查 lib/client.js`);
}
// 卡片那一侧的真样式表，和面板同一份产物、同一个取法（`.hxw-cv{` 是其入口）。
const cardCssAnchor = bundle.indexOf(".hxw-cv{");
if (cardCssAnchor < 0) throw new Error("lib/client.js 里没有找到 .hxw-cv 样式表，请先运行 node scripts/build.mjs");
const cardCssStart = bundle.lastIndexOf("`", cardCssAnchor);
const cardCssEnd = bundle.indexOf("`", cardCssAnchor);
if (cardCssStart < 0 || cardCssEnd < 0) throw new Error("lib/client.js 里卡片样式表不是模板字符串，取不到完整 CSS");
const cardCss = bundle
  .slice(cardCssStart + 1, cardCssEnd)
  .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
if (!cardCss.includes(".hxw-block") || !cardCss.includes(".hxw-cv-meta") || !cardCss.trimEnd().endsWith("}")) {
  throw new Error(`卡片 CSS 取到的不是完整样式表（${cardCss.length} 字符），请检查 lib/client.js`);
}

// 2) DSH 主题令牌（缺失时退回 preview-modal.mjs 的那套深色硬编码值，只影响预览）
const tokenFile = path.join(workspace, ".cache", "dsh-ref", "dsw-tokens.json");
const FALLBACK = {
  "--dsw-alias-bg-base": "#232e2d",
  "--dsw-alias-bg-layer-1": "#232e2d",
  "--dsw-alias-bg-layer-2": "#283332",
  "--dsw-alias-bg-layer-3": "#2c3836",
  "--dsw-alias-label-primary": "#ccd8d3",
  "--dsw-alias-label-secondary": "#a9b5b0",
  "--dsw-alias-label-tertiary": "#9aa6a1",
  "--dsw-alias-label-primary-foreground": "#131a19",
  "--dsw-alias-link": "#4cb08a",
  "--dsw-alias-button-info-fill": "#4cb08a",
  "--dsw-alias-button-info-hover": "#2f8f6b",
  "--dsw-alias-border-l1": "#ffffff0f",
  "--dsw-alias-border-l2": "#ffffff1f",
  "--dsw-alias-border-l3": "#ffffff29",
  "--dsw-alias-interactive-bg-hover": "#ffffff14",
  "--dsw-alias-interactive-bg-active": "#ffffff24",
  "--dsw-alias-state-success-primary": "#a6d189",
  "--dsw-alias-state-error-primary": "#e78284",
  "--dsw-alias-interactive-bg-hover-danger": "#f25a5a26",
  "--dsw-alias-bg-base-hover": "#ffffff14",
};
let tokenCss;
if (fs.existsSync(tokenFile)) {
  const tokens = JSON.parse(fs.readFileSync(tokenFile, "utf8"));
  const body = (map) => Object.entries(map ?? {}).map(([key, value]) => `  --${key}: ${value};`).join("\n");
  const theme = (name) => `:root[data-theme="${name}"]{\n${body(tokens[`${name}_static`])}\n${body(tokens[`${name}_alias`])}\n${body(tokens[`${name}_specific`])}\n}`;
  tokenCss = [theme("light"), theme("dark")].join("\n");
} else {
  console.log(`提示：${tokenFile} 不存在，预览使用回退色（深色令牌），浅色那张也会偏暗`);
  tokenCss = `:root{\n${Object.entries(FALLBACK).map(([key, value]) => `  ${key}: ${value};`).join("\n")}\n}`;
}

/* ------------------------------------------------------------------ *
 * 3) 真实组件渲染：桩掉 HTTP 接口，喂一份像样的演示资料
 * ------------------------------------------------------------------ */
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://127.0.0.1:19387/", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// 产物在顶层就会碰这些浏览器全局（例如把 <style> 挂到 document.head 时用
// `instanceof HTMLStyleElement` 判类型），所以照实铺一遍，别等它抛错。
for (const name of ["HTMLElement", "HTMLStyleElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLButtonElement", "Element", "Node", "Event", "CustomEvent", "MouseEvent", "KeyboardEvent", "FileReader", "File", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  if (name in dom.window) globalThis[name] = dom.window[name];
}
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

// 40 位十六进制 = 内容寻址的图片 id（和 Host 真正写盘的形状一致）
const ASSET_COVER = "9a1c4f7b23e05d88614af2c0b7d3e5f60a1b2c3d";
const ASSET_CHART = "b47d0e9a1c2f3856ab94d7e0f1a2b3c4d5e6f708";
const ASSET_PHOTO = "1f2e3d4c5b6a7988071625344352617080900a0b";

const tag = (id, name) => ({ id, name });
const text = (id, body) => ({ id, kind: "text", text: body });
const image = (id, asset, caption) => ({ id, kind: "image", asset, caption });

const doc = {
  version: 1,
  revision: 12,
  updatedAt: "2026-10-02T09:24:00.000Z",
  tags: [
    tag("t-research", "研究"),
    tag("t-read", "待读"),
    tag("t-idea", "产品灵感"),
    tag("t-prompt", "提示词"),
    tag("t-howto", "教程"),
  ],
  cards: [
    {
      id: "card-half",
      title: "插件开发笔记：Host 与 Client 各管一半",
      tags: ["t-research", "t-howto"],
      source: "https://github.com/anbeime/dsh-plugins",
      blocks: [
        text("b1", "服务端半边负责落盘与 HTTP 路由，客户端半边只管把状态画出来。两边共用一个 documents API：GET /state 读，POST /save 写，写的时候带上 baseRevision，撞车了就用 409 把选择权交回给人。"),
        text("b2", "图片不进 works.json，只留内容寻址的 id，字节放在 assets/ 里，所以同一张图重复粘贴不会多占空间。"),
        image("b3", ASSET_COVER, "面板截图：左侧标签栏，中间卡片列表"),
        image("b4", ASSET_CHART, "数据流：Client → /api/dsh-helloai-works → DSH_HOME/helloai-works"),
      ],
      createdAt: "2026-10-02T09:20:00.000Z",
      updatedAt: "2026-10-02T09:24:00.000Z",
    },
    {
      id: "card-mention",
      title: "把回复收进卡片：@ 引用的实现要点",
      tags: ["t-prompt", "t-research"],
      source: "https://example.com/notes/at-mention",
      blocks: [
        text("b5", "输入框里打一个 @，候选表由插件自己提供：卡片按更新时间排在前面，标签分组跟在后面。选中之后插入的是一枚 chip，提交时把卡片正文序列化成带标题、标签、来源和采集日期的纯文本。"),
        text("b6", "候选函数必须是 async：管线用 .then 接结果，同步返回数组会让整个菜单卡在加载态。"),
      ],
      createdAt: "2026-10-01T15:40:00.000Z",
      updatedAt: "2026-10-01T16:02:00.000Z",
    },
    {
      id: "card-image",
      title: "图片入库策略：1500 px 上限与透明通道",
      tags: ["t-howto"],
      source: "https://developer.mozilla.org/zh-CN/docs/Web/API/Canvas_API",
      blocks: [
        text("b7", "超过 1500 px 宽的图片先按同比例缩放再编码；PNG 保持 PNG，透明不被压掉；已经在上限内的图片一个字节都不动，省掉一次没必要的重编码。"),
        image("b8", ASSET_PHOTO, "缩放前后对比"),
      ],
      createdAt: "2026-09-30T11:05:00.000Z",
      updatedAt: "2026-09-30T11:30:00.000Z",
    },
    {
      id: "card-backup",
      title: "备份与快照的区别（含恢复步骤）",
      tags: ["t-howto", "t-read"],
      source: "",
      blocks: [
        text("b9", "完整备份是一个自包含的 JSON，图片以 base64 内联，换台机器也能还原；自动快照只存卡片文字、不含图片字节，适合「改错了退回去」。"),
        text("b10", "恢复前先导一次完整备份——这是唯一一条不需要犹豫的建议。"),
      ],
      createdAt: "2026-09-29T18:22:00.000Z",
      updatedAt: "2026-09-29T18:22:00.000Z",
    },
    {
      id: "card-tags",
      title: "标签体系：先按用途分组，再按来源补",
      tags: ["t-idea"],
      source: "https://example.com/notes/tagging",
      blocks: [
        text("b11", "标签太细就没人维护，太粗又搜不出来。实践下来：一级标签只按「拿它干什么」分，来源、语言这些可枚举的维度交给搜索框，别做成标签。"),
      ],
      createdAt: "2026-09-28T10:10:00.000Z",
      updatedAt: "2026-09-28T10:10:00.000Z",
    },
    {
      id: "card-local-first",
      title: "待读：本地优先的个人知识库设计",
      tags: ["t-read"],
      source: "https://www.inkandswitch.com/local-first/",
      blocks: [
        text("b12", "离线可用、数据在用户手里、多端最终一致——这三件事其实是同一个约束推出来的。同步引擎要处理的是冲突语义，不是网络协议。"),
      ],
      createdAt: "2026-09-26T08:45:00.000Z",
      updatedAt: "2026-09-26T08:45:00.000Z",
    },
    {
      id: "card-prompt",
      title: "提示词：让模型输出结构化卡片",
      tags: ["t-prompt", "t-idea"],
      source: "",
      blocks: [
        text("b13", "先给字段表，再给两条正例一条反例，最后要求「只输出 JSON，不要解释」。字段名保持英文，正文保持中文，解析和阅读都省事。"),
      ],
      createdAt: "2026-09-25T21:30:00.000Z",
      updatedAt: "2026-09-25T21:30:00.000Z",
    },
    {
      id: "card-note",
      title: "随手记：侧边栏的宽度与折叠",
      tags: [],
      source: "",
      blocks: [
        text("b14", "面板窄于 1080 px 时标签栏整条折掉，窄于 760 px 时右侧编辑器让位给列表。断点写在 @container 里，跟着容器而不是窗口走。"),
      ],
      createdAt: "2026-09-24T14:02:00.000Z",
      updatedAt: "2026-09-24T14:02:00.000Z",
    },
  ],
};

const BACKUPS = {
  directory: "C:\\Users\\example\\.dsh\\helloai-works\\backups",
  records: [
    { name: "works-full-2026-10-02T09-24-11.json", kind: "full", bytes: 482113, mtime: "2026-10-02T09:24:11.000Z" },
    { name: "works-2026-10-02T09-00-00.json", kind: "snapshot", bytes: 18244, mtime: "2026-10-02T09:00:00.000Z" },
  ],
};

const calls = [];
const json = (data, ok = true, status = 200) => ({ ok, status, json: async () => ({ ok, ...data }) });
dom.window.fetch = globalThis.fetch = async (url, init = {}) => {
  calls.push(String(url));
  const target = String(url);
  if (target.endsWith("/state")) {
    return json({ doc, revision: doc.revision, assets: [ASSET_COVER, ASSET_CHART, ASSET_PHOTO], root: "C:\\Users\\example\\.dsh\\helloai-works", docPath: "C:\\Users\\example\\.dsh\\helloai-works\\works.json" });
  }
  if (target.endsWith("/backups")) return json(BACKUPS);
  return json({ revision: doc.revision });
};

let loaded;
dom.window.__ModuleLoader__ = { load: ({ factory }) => { loaded = factory(requireModule); } };
new Function("window", "document", "require", "module", "exports", bundle)(dom.window, dom.window.document, requireModule, { exports: {} }, {});
if (!loaded?.apply) throw new Error("client bundle 没有导出 apply()");

// 假 ctx：只提供面板需要的那几个服务，并把插件注册的东西收下来。
// 字典是插件自己 register 进来的，所以 t() 用的是真文案而不是 key。
const registrations = [];
const dictionaries = {};
// `openCard` 走真路径：它把卡片交给 ctx.sidebarRight.openTab，这里把这次调用记下来，
// 才能知道「哪张卡片、以哪个类型」被请求打开（右键栏的 slot 也认这个类型）。
const openedTabs = [];
const fakeContext = {
  effect: (run) => run(),
  // `@` 触发管线：真 DSH 里有，这里给个空实现，面板才不会挂出
  // 「@ 引用未接入」的警告行（那行只在降级环境里出现，不该进预览图）。
  get: (name) => (name === "inputTriggers" ? { registerSource: () => () => {} } : undefined),
  inject: (_dependencies, callback) => (callback(fakeContext), () => {}),
  on: () => () => {},
  locale: {
    register: (namespace, dictionary) => ((dictionaries[namespace] = dictionary), () => {}),
    bind: () => (key) => dictionaries["helloai-works"]?.zh?.[key] ?? key,
  },
  slots: {
    inject: (_name, factory) => factory(),
    register: (options, component) => (registrations.push({ options, component }), () => {}),
  },
  sidebarRightTabs: { register: () => () => {} },
  sidebarRight: { openTab: (kind, options) => (openedTabs.push({ kind, cardId: options?.params?.cardId }), undefined) },
};
loaded.apply(fakeContext);

const byName = (name) => registrations.find((item) => item.options.name === name);
const panel = byName("main");
const sidebarRow = byName("sidebar.panellist");
if (!panel) throw new Error(`没有注册面板组件（main），只收到底座：${registrations.map((item) => item.options.name).join(", ")}`);
if (!sidebarRow) throw new Error("没有注册左侧边栏那一行（sidebar.panellist）");
// 右侧栏里显示一张卡片的那个组件：真 DSH 点开卡片时用的就是它。
const cardTabBody = byName("sidebar.right.pane.tab");
const cardTabChip = byName("sidebar.right.pane.tab.title");
if (!cardTabBody) throw new Error("没有注册卡片页组件（sidebar.right.pane.tab）");

const zh = dictionaries["helloai-works"]?.zh ?? {};
/** 真字典 + 一次 {name} 插值，等价于 DSH 那边 locale.bind 给出的 t。 */
const t = (key, params) => {
  const template = typeof zh[key] === "string" ? zh[key] : key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
};

/** 面板拿到的 openCard 就是产品里那个：调用右侧栏，返回它选的卡片 id（失败为 null）。 */
const cardOpenings = [];
const openCard = (cardId) => {
  cardOpenings.push(cardId);
  panel.options.inject().openCard(cardId);
  return cardId;
};

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rootElement = document.getElementById("root");
const root = createRoot(rootElement);
root.render(React.createElement(panel.component, { t, openCard }));
// 面板挂载时会 start() → GET /state，等状态落定再取 DOM。
await settle(700);

const mounted = rootElement.innerHTML;

// 截图前的自检：截图是写文件之后由 Chrome 拍的，这里先把「没渲染出来」和
// 「版本漂移」这类静默失败挡在前面。
const problems = [];
if (!mounted.includes("HELLOAI | CARD RECORD")) problems.push("页头没有 HELLOAI | CARD RECORD");
if (!new RegExp(`>\\s*V${version.replace(/\./g, "\\.")}\\s*<`).test(mounted)) problems.push(`页头没有 V${version} 角标（产物可能是旧的，先跑 node scripts/build.mjs）`);
if ((mounted.match(/class="hxw-tag-row"/g) ?? []).length < 3) problems.push("左侧标签栏没有渲染出标签");
if ((mounted.match(/class="hxw-card"/g) ?? []).length < 5) problems.push("卡片列表没有渲染出卡片");
if (!mounted.includes("🖼")) problems.push("没有卡片带图片角标（演示资料里的图片块没生效）");
if (panelCss.length < 10000) problems.push(`面板 CSS 只有 ${panelCss.length} 字符，像是被截断了`);
if (problems.length) throw new Error(`预览自检未通过：\n - ${problems.join("\n - ")}`);

const cardCount = (mounted.match(/class="hxw-card"/g) ?? []).length;
const tagCount = (mounted.match(/class="hxw-tag-row"/g) ?? []).length;
console.log(`渲染完成：${cardCount} 张卡片、${tagCount} 行标签，接口调用 ${calls.filter((url) => url.endsWith("/state")).length} 次 /state`);

/* ------------------------------------------------------------------ *
 * 3b) 真的打开一张卡片：调用面板的 openCard，再把右侧栏那个组件渲染出来
 * ------------------------------------------------------------------ */

// 演示用哪张卡片：带两个标签、两段正文、两张图，编辑器该有的零件它都有。
const OPEN_CARD_ID = "card-half";
openCard(OPEN_CARD_ID);
// 真 openCard 会 ctx.sidebarRight.openTab(kind, { params: { cardId } })，卡片 id 只能从
// 那次调用里拿；拿不到说明这条路已经不是产品里那条路了，宁可报错也不摆拍。
const openedTab = openedTabs.at(-1);
if (!openedTab || openedTab.cardId !== OPEN_CARD_ID) {
  throw new Error(`openCard 没有把卡片交给右侧栏（收到：${JSON.stringify(openedTab)}）`);
}
console.log(`打开卡片：${OPEN_CARD_ID} → ${openedTab.kind}（右侧栏 tab 已注册，用同一个 id 渲染）`);

// 卡片页从 tab 的 navigation.params 里读 cardId —— 和真 DSH 传给它的东西同形。
const tabInfo = { tab: { id: "helloai-works-preview", navigation: { params: { cardId: OPEN_CARD_ID } } } };

/** 面板和卡片是两棵互不嵌套的 React 子树（真 DSH 里它们也在两个栏里），所以各挂各的。 */
async function renderSubtree(name, element) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const subtree = createRoot(host);
  subtree.render(element);
  await settle(80);
  const html = host.innerHTML;
  subtree.unmount();
  host.remove();
  if (!html) throw new Error(`${name} 渲染出来是空的`);
  return html;
}

const cardHtml = await renderSubtree(`${OPEN_CARD_ID} 的卡片页`, React.createElement(cardTabBody.component, { t, useTabInfo: () => tabInfo }));
const chipHtml = cardTabChip ? await renderSubtree(`${OPEN_CARD_ID} 的 tab 标题`, React.createElement(cardTabChip.component, { t, useTabInfo: () => tabInfo })) : "";

// 卡片自己会带一份 <style>{CARD_CSS}</style>：抽到页面级去（同一份样式表，重复入队
// 只会让浏览器多解析一遍），剩下的才是卡片正文。
const styleTag = /<style>([\s\S]*?)<\/style>/;
const cardStyleBlock = cardHtml.match(styleTag);
if (!cardStyleBlock) throw new Error("卡片正文里没有找到 <style>，CARD_CSS 可能换地方了");
const cardHtmlBody = cardHtml.replace(styleTag, "");
if (cardHtmlBody === cardHtml) throw new Error("卡片正文里的 <style> 没抽掉");

const cardProblems = [];
if (!cardHtmlBody.includes("hxw-cv-body")) cardProblems.push("卡片正文没有渲染出来（hxw-cv-body）");
if ((cardHtmlBody.match(/class="hxw-chip-btn"/g) ?? []).length < 3) cardProblems.push("卡片里没有标签胶囊（hxw-chip-btn）");
if (!(cardHtmlBody.match(/class="hxw-chip-btn" data-on="true"/g) ?? []).length) cardProblems.push("卡片的标签里没有一个处于选中态");
if ((cardHtmlBody.match(/class="hxw-text-block"/g) ?? []).length < 1) cardProblems.push("卡片里没有文字块");
if ((cardHtmlBody.match(/class="hxw-figure"/g) ?? []).length < 1) cardProblems.push("卡片里没有图片块");
if (!/<input type="date" value="\d{4}-\d{2}-\d{2}"\/?>/.test(cardHtmlBody)) cardProblems.push("卡片里没有「收集于」的日期输入");
if (!cardHtmlBody.includes('data-icon="source"')) cardProblems.push("卡片里没有「来源」图标");
if (!cardHtmlBody.includes('class="hxw-save"')) cardProblems.push("卡片里没有保存状态（hxw-save）");
if (!chipHtml.includes("hxw-chip-title")) cardProblems.push("右侧栏 tab 标题没有渲染出来");
if (cardProblems.length) throw new Error(`卡片预览自检未通过：\n - ${cardProblems.join("\n - ")}`);
console.log(
  `卡片渲染完成：${(cardHtmlBody.match(/class="hxw-chip-btn"/g) ?? []).length} 个标签胶囊、` +
    `${(cardHtmlBody.match(/class="hxw-text-block"/g) ?? []).length} 段文字、` +
    `${(cardHtmlBody.match(/class="hxw-figure"/g) ?? []).length} 张图片`,
);

/* ------------------------------------------------------------------ *
 * 3c) 卡片里的图片：API 地址换成内联 SVG 占位图
 *
 * 预览页是 file:// 打开的，`/api/dsh-helloai-works/asset/<id>` 取不到字节，
 * 图片块只会渲染成「缺图」虚线框。卡片里的图是内容寻址的私有字节，没法也不该
 * 打进仓库，所以这里按同一尺寸画一张同色系的示意 SVG 顶上去——截图里看到的
 * 是「图片块 + 说明」这个真结构，只有像素是示意。面板那两张不带图片块，不受影响。
 * ------------------------------------------------------------------ */

/** 只给 data URI 留 ASCII，`#`/`<`/`>` 这些让 URI 提前断掉或截断的字符全部转义。 */
function svgDataUri(svg) {
  return `data:image/svg+xml,${svg.replace(/"/g, "'").replace(/</g, "%3c").replace(/>/g, "%3e").replace(/#/g, "%23").replace(/[\n\r]+/g, " ")}`;
}

/** 面板示意：左边一条标签栏、中间一列卡片。 */
const COVER_SVG = svgDataUri(
  '<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'880\' height=\'420\'>' +
    '<rect width=\'880\' height=\'420\' fill=\'#263130\'/>' +
    '<rect x=\'14\' y=\'14\' width=\'150\' height=\'392\' rx=\'10\' fill=\'#2f3d3b\'/>' +
    '<rect x=\'26\' y=\'30\' width=\'126\' height=\'16\' rx=\'8\' fill=\'#4c6360\'/>' +
    '<rect x=\'26\' y=\'60\' width=\'96\' height=\'14\' rx=\'7\' fill=\'#3d4f4d\'/>' +
    '<rect x=\'26\' y=\'86\' width=\'110\' height=\'14\' rx=\'7\' fill=\'#3d4f4d\'/>' +
    '<rect x=\'26\' y=\'112\' width=\'84\' height=\'14\' rx=\'7\' fill=\'#3d4f4d\'/>' +
    '<rect x=\'26\' y=\'138\' width=\'102\' height=\'14\' rx=\'7\' fill=\'#3d4f4d\'/>' +
    '<rect x=\'182\' y=\'14\' width=\'270\' height=\'84\' rx=\'10\' fill=\'#2f3d3b\'/>' +
    '<rect x=\'196\' y=\'28\' width=\'170\' height=\'13\' rx=\'6\' fill=\'#587370\'/>' +
    '<rect x=\'196\' y=\'52\' width=\'230\' height=\'10\' rx=\'5\' fill=\'#43554f\'/>' +
    '<rect x=\'196\' y=\'70\' width=\'190\' height=\'10\' rx=\'5\' fill=\'#43554f\'/>' +
    '<rect x=\'182\' y=\'110\' width=\'270\' height=\'84\' rx=\'10\' fill=\'#2f3d3b\'/>' +
    '<rect x=\'196\' y=\'124\' width=\'200\' height=\'13\' rx=\'6\' fill=\'#587370\'/>' +
    '<rect x=\'196\' y=\'148\' width=\'236\' height=\'10\' rx=\'5\' fill=\'#43554f\'/>' +
    '<rect x=\'196\' y=\'166\' width=\'150\' height=\'10\' rx=\'5\' fill=\'#43554f\'/>' +
    '<rect x=\'182\' y=\'206\' width=\'270\' height=\'84\' rx=\'10\' fill=\'#2f3d3b\'/>' +
    '<rect x=\'196\' y=\'220\' width=\'186\' height=\'13\' rx=\'6\' fill=\'#587370\'/>' +
    '<rect x=\'196\' y=\'244\' width=\'226\' height=\'10\' rx=\'5\' fill=\'#43554f\'/>' +
    '<rect x=\'196\' y=\'262\' width=\'164\' height=\'10\' rx=\'5\' fill=\'#43554f\'/>' +
    '<rect x=\'182\' y=\'302\' width=\'270\' height=\'84\' rx=\'10\' fill=\'#2f3d3b\'/>' +
    '<rect x=\'196\' y=\'316\' width=\'140\' height=\'13\' rx=\'6\' fill=\'#587370\'/>' +
    '<rect x=\'196\' y=\'340\' width=\'220\' height=\'10\' rx=\'5\' fill=\'#43554f\'/>' +
    '<rect x=\'470\' y=\'14\' width=\'396\' height=\'392\' rx=\'10\' fill=\'#2a3533\'/>' +
    '<rect x=\'490\' y=\'34\' width=\'250\' height=\'14\' rx=\'7\' fill=\'#587370\'/>' +
    '<rect x=\'490\' y=\'62\' width=\'356\' height=\'10\' rx=\'5\' fill=\'#3d4f4d\'/>' +
    '<rect x=\'490\' y=\'82\' width=\'330\' height=\'10\' rx=\'5\' fill=\'#3d4f4d\'/>' +
    '<rect x=\'490\' y=\'102\' width=\'300\' height=\'10\' rx=\'5\' fill=\'#3d4f4d\'/>' +
    '<rect x=\'490\' y=\'140\' width=\'356\' height=\'120\' rx=\'12\' fill=\'#35443f\'/>' +
    '<path d=\'M490 244 L570 178 L640 224 L720 150 L790 214 L846 168\' fill=\'none\' stroke=\'#7fd1b0\' stroke-width=\'3\'/>' +
    '<rect x=\'490\' y=\'286\' width=\'356\' height=\'10\' rx=\'5\' fill=\'#3d4f4d\'/>' +
    '<rect x=\'490\' y=\'306\' width=\'300\' height=\'10\' rx=\'5\' fill=\'#3d4f4d\'/>' +
    '<rect x=\'490\' y=\'326\' width=\'336\' height=\'10\' rx=\'5\' fill=\'#3d4f4d\'/>' +
    '</svg>',
);

/** 数据流示意：Client → HTTP → DSH_HOME。 */
const CHART_SVG = svgDataUri(
  '<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'880\' height=\'300\'>' +
    '<rect width=\'880\' height=\'300\' fill=\'#252f2e\'/>' +
    '<rect x=\'46\' y=\'96\' width=\'180\' height=\'108\' rx=\'12\' fill=\'#2f3d3b\' stroke=\'#4c6360\'/>' +
    '<rect x=\'350\' y=\'96\' width=\'180\' height=\'108\' rx=\'12\' fill=\'#2f3d3b\' stroke=\'#4c6360\'/>' +
    '<rect x=\'654\' y=\'96\' width=\'180\' height=\'108\' rx=\'12\' fill=\'#2f3d3b\' stroke=\'#4c6360\'/>' +
    '<path d=\'M232 150 L344 150\' stroke=\'#7fd1b0\' stroke-width=\'3\'/>' +
    '<path d=\'M336 143 L348 150 L336 157\' fill=\'none\' stroke=\'#7fd1b0\' stroke-width=\'3\'/>' +
    '<path d=\'M536 150 L648 150\' stroke=\'#7fd1b0\' stroke-width=\'3\'/>' +
    '<path d=\'M640 143 L652 150 L640 157\' fill=\'none\' stroke=\'#7fd1b0\' stroke-width=\'3\'/>' +
    '<circle cx=\'136\' cy=\'130\' r=\'12\' fill=\'none\' stroke=\'#8fb3a8\' stroke-width=\'3\'/>' +
    '<circle cx=\'440\' cy=\'130\' r=\'12\' fill=\'none\' stroke=\'#8fb3a8\' stroke-width=\'3\'/>' +
    '<circle cx=\'744\' cy=\'130\' r=\'12\' fill=\'none\' stroke=\'#8fb3a8\' stroke-width=\'3\'/>' +
    '<rect x=\'96\' y=\'160\' width=\'80\' height=\'9\' rx=\'4\' fill=\'#5d7c8c\'/>' +
    '<rect x=\'400\' y=\'160\' width=\'80\' height=\'9\' rx=\'4\' fill=\'#5d7c8c\'/>' +
    '<rect x=\'704\' y=\'160\' width=\'80\' height=\'9\' rx=\'4\' fill=\'#5d7c8c\'/>' +
    '<rect x=\'96\' y=\'178\' width=\'52\' height=\'9\' rx=\'4\' fill=\'#41544f\'/>' +
    '<rect x=\'400\' y=\'178\' width=\'52\' height=\'9\' rx=\'4\' fill=\'#41544f\'/>' +
    '<rect x=\'704\' y=\'178\' width=\'52\' height=\'9\' rx=\'4\' fill=\'#41544f\'/>' +
    '</svg>',
);

// assetUrl() 的形状是 /api/dsh-helloai-works/asset/<id>，逐块换掉。
const PLACEHOLDERS = new Map([
  [ASSET_COVER, COVER_SVG],
  [ASSET_CHART, CHART_SVG],
  [ASSET_PHOTO, COVER_SVG],
]);
const inlined = [];
const cardHtmlInlined = cardHtmlBody.replace(/\/api\/dsh-helloai-works\/asset\/([0-9a-f]{40})/g, (match, assetId) => {
  const data = PLACEHOLDERS.get(assetId);
  if (!data) return match;
  inlined.push(assetId);
  return data;
});
if (!inlined.length) throw new Error("卡片里的图片地址一个都没换掉，图片块可能没渲染");
console.log(`图片块内联完成：${inlined.length} 张（${[...new Set(inlined)].map((id) => id.slice(0, 8)).join("、")}）`);

/* ------------------------------------------------------------------ *
 * 4) 序列化成一页静态 HTML，再交给无头 Chrome 截图
 * ------------------------------------------------------------------ */

// 组件自己带的 <style> 都抽到页面级去排队（同一份样式表解析两遍没意义，
// 塞进画框的那份 HTML 也更干净）。面板那张保持原样：它的截图必须一个像素不变。
const shell = (mode, body, options = {}) => {
  const head = options.head ?? "";
  const pageClass = options.twoColumn ? "page page-two" : "page";
  // 宽度必须写死成数值：面板自带 `container-type:inline-size`，而 width:max-content
  // 这种「内容宽度」在 @container 求值时是无限的，容器查询会退回小视口，把左侧
  // 标签栏整条折掉。写死宽度＝内容宽度，查询才有参照。
  const pageWidth = options.twoColumn ? FRAME_WIDTH + PAGE_PAD * 2 : PANEL_WIDTH + PAGE_PAD * 2;
  return `<!doctype html>
<html lang="zh-CN" data-theme="${mode}">
<head>
<meta charset="utf-8">
<title>helloai-works panel (${mode})</title>
<style>
${tokenCss}

*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:"Microsoft YaHei","Segoe UI",system-ui,sans-serif}
${panelCss}
${cardCss}
${head}

/* 预览页自己的画框：面板是全高 flex 布局，得给它一个明确的宽高。宽度必须
   大于 1080px，否则插件的 @container 会把左侧标签栏折掉。打开卡片的版式是
   「面板 + 右侧栏」两栏并排，和真 DSH 一样。
   .page 写死宽度再居中，两个画框都 flex:none，免得 flex 为了塞进窗口把它们
   压缩——面板那张必须和以前一个像素都不差。 */
.page{display:flex;justify-content:center;width:${pageWidth}px;margin:0 auto;padding:${PAGE_PAD}px}
.page-two{gap:${COLUMN_GAP}px}
.frame{flex:none;width:${PANEL_WIDTH}px;height:${PANEL_HEIGHT}px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;overflow:hidden;background:var(--dsw-alias-bg-base)}
/* 右侧栏那一栏：真 DSH 里它是独立的滚动栏，这里照抄「一个圆角框 + 内部滚动」。 */
.card-col{flex:none;display:flex;flex-direction:column;width:${CARD_WIDTH}px;height:${PANEL_HEIGHT}px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;overflow:hidden;background:var(--dsw-alias-bg-base)}
.card-col-head{flex:none;border-bottom:1px solid var(--dsw-alias-border-l1);padding:9px 12px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.card-col-body{flex:1;min-height:0;display:flex}
${options.extraCss ?? ""}
</style>
</head>
<body>
<div class="${pageClass}">${body}</div>
</body>
</html>`;
};

const chrome = findChrome();
if (!chrome) {
  console.log("跳过：没找到 Chrome/Chromium，可用 DSH_PREVIEW_CHROME 指定路径");
  process.exit(0);
}

const shoot = (page, shot, size) => {
  execFileSync(chrome, [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    `--window-size=${size}`, `--screenshot=${shot}`, `file:///${page.replace(/\\/g, "/")}`,
  ], { stdio: "ignore" });
  return shot;
};

/* 文字块的高度校正
 *
 * 卡片里的标题和文字块是 AutoTextarea：真浏览器里它靠 useLayoutEffect 读
 * scrollHeight 把 textarea 撑到内容高度。jsdom 没有排版，量出来是 0，于是每个
 * 输入框都带着内联 `height:0px` 落进截图——正文会被裁成一两行。样式表和 DOM 都是
 * 插件自己的，被裁的只有渲染，所以这里按插件 CSS 里的字号/行高，加上这一栏的
 * 实际可用宽度，把内容高度算出来写回内联（CSS 自己写死 height:0px 的内联样式，
 * 只有内联能盖过它；Chrome 的 --dump-dom 不返回排版，也不跑页面脚本，量不了）。
 */
const FIT = { cjk: 1, wide: 0.6, narrow: 0.55, space: 0.3, lineHeight: 1.65, padding: 10, minHeight: 30 };
/**
 * 折行的「有效宽度」比实际排版宽度窄一档：标点、英文单词、避头尾都会让一行装不下
 * 按字宽算出来的那么多字。宁可多留一行空白（textarea 空着几行什么也看不出来），
 * 也不能少算——少一行，输入框就会把内容滚到底、把末行推出可视区。这两个值对着
 * 真 Chrome 量过：正文框 320px ≈ 20 个汉字宽，标题框 414px ≈ 26 个。
 */
const BLOCK_FOLD_WIDTH = 284;
const TITLE_FOLD_WIDTH = 372;

/** 一个字的相对宽度：汉字全角，拉丁/数字大约半个多。 */
function charWidth(code) {
  if (code === 0x20) return FIT.space;
  if (code < 0x2e80) return FIT.narrow;
  if (code >= 0xff00 && code <= 0xff60) return FIT.wide;
  return FIT.cjk;
}

/** 按可用宽度把一段文字折行，返回行数（\n 强制换行）。 */
function foldLines(text, width, fontSize) {
  let lines = 0;
  for (const paragraph of String(text).split("\n")) {
    let used = 0;
    let line = 1;
    for (const char of paragraph) {
      const units = charWidth(char.codePointAt(0));
      if (used > 0 && used + units > width) {
        line += 1;
        used = 0;
      }
      used += units;
    }
    lines += line;
  }
  return Math.max(1, lines);
}

/** 一个文字块（或标题）需要的高度，单位 px，已含内边距。 */
function fitHeight(text, width, fontSize) {
  return Math.max(FIT.minHeight, Math.round(foldLines(text, width / fontSize, fontSize) * fontSize * FIT.lineHeight + FIT.padding));
}

/** jsdom 给的 `height:0px` 换成按内容算出来的高度（1px 余量，宁松不裁）。 */
function fitTextareas(html) {
  const titleTag = html.match(/<textarea class="hxw-cv-title"[^>]*>[\s\S]*?<\/textarea>/)?.[0];
  if (!titleTag) throw new Error("卡片里没有标题框，没法校正高度");
  const blocks = html.match(/<textarea class="hxw-text-block"[^>]*>[\s\S]*?<\/textarea>/g) ?? [];
  if (blocks.length < 1) throw new Error("卡片里没有文字块，没法校正高度");

  let out = html.replace(titleTag, titleTag.replace(/(style=")([^"]*)(")/, (_all, before, css, after) => `${before}${css}height:${fitHeight(titleTag.replace(/^[\s\S]*?>/, "").replace(/<\/textarea>$/, ""), TITLE_FOLD_WIDTH, 15.5) + 1}px${after}`));
  for (const tag of blocks) {
    const text = tag.replace(/^[\s\S]*?>/, "").replace(/<\/textarea>$/, "");
    const height = fitHeight(text, BLOCK_FOLD_WIDTH, 13.5) + 1;
    out = out.replace(tag, tag.replace(/(style=")([^"]*)(")/, (_all, before, css, after) => `${before}${css}height:${height}px${after}`));
  }
  const done = [...out.matchAll(/<textarea class="hxw-(?:cv-title|text-block)"[^>]*style="[^"]*height:(\d+)px/g)];
  if (done.length < blocks.length + 1) throw new Error(`只给 ${done.length} 个输入框算出了高度，应该是 ${blocks.length + 1} 个`);
  return out;
}

const shots = [];
for (const mode of ["dark", "light"]) {
  const page = path.join(output, `panel-${mode}.html`);
  const shot = path.join(output, `panel-${mode}.png`);
  fs.writeFileSync(page, shell(mode, `<div class="frame">${mounted}</div>`), "utf8");
  shoot(page, shot, SHOT_SIZE);
  shots.push(shot);
  console.log("渲染完成：", shot, `(${fs.statSync(shot).size} 字节)`);
}

/* ---- 打开卡片的版式：左面板 + 右侧栏里的真卡片 ---- */

// 预览页自己的补丁，只作用于右侧这一栏（面板那张一个像素都不动）：
// AutoTextarea 在 jsdom 里量不到高度，所以高度由 fitTextareas 算好写进内联。
const cardPreviewCss = `
.card-col-body>.frame,.card-col-body>div{width:100%;height:100%;min-width:0}
.card-col-body textarea{overflow:hidden}
/* 真浏览器里日期输入框自带日历按钮，jsdom 里没有；预览页按真浏览器那样补上，
   免得「收集于」看起来像个空框。 */
.card-col-body input[type=date]::-webkit-calendar-picker-indicator{opacity:.75;cursor:pointer}
`;

const cardColumn = `<section class="card-col"><div class="card-col-head">${chipHtml}</div><div class="card-col-body">${fitTextareas(cardHtmlInlined)}</div></section>`;

for (const mode of ["dark", "light"]) {
  const page = path.join(output, `card-open-${mode}.html`);
  const shot = path.join(output, `card-open-${mode}.png`);
  fs.writeFileSync(page, shell(mode, `<div class="frame">${mounted}</div>${cardColumn}`, { twoColumn: true, extraCss: cardPreviewCss }), "utf8");
  shoot(page, shot, CARD_SHOT_SIZE);
  shots.push(shot);
  console.log("渲染完成：", shot, `(${fs.statSync(shot).size} 字节)`);
}

console.log("\n产物：");
for (const shot of shots) {
  const { size } = fs.statSync(shot);
  console.log(`  ${shot}  ${size} 字节`);
}

// jsdom 这一侧还有计时器挂着，显式关掉，脚本干净退出。
dom.window.close();
