/**
 * Self-test for dsh-helloai-works.
 *
 * Five passes, all without DeepSeek Harness running:
 *   1. the built Host half, over a real HTTP socket and a throwaway DSH_HOME;
 *   2. the built client bundle, loaded through a stand-in module loader and
 *      rendered with react-dom/server;
 *   3. the client store driving real save conflicts against that live server;
 *   4. the same store driving every tag and card operation;
 *   5. route ownership: disposing the fiber releases the prefix route, so the
 *      next activation cannot fail with a duplicate route.
 *
 *   node scripts/selftest.mjs
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);

/**
 * The process's own `fetch`, captured before any pass stands a stand-in up: the
 * client half fetches a relative API path, which Node cannot resolve, so pass 3
 * has to reach the socket through this one rather than through whatever the
 * client pass left behind.
 */
const nativeFetch = globalThis.fetch;

/**
 * The browser loads this bundle straight off disk on every request, so a stale
 * `lib/` would quietly serve old code while the tests pass against the old
 * build. Refuse to run rather than report a green result for code nobody ships.
 */
async function assertFreshBuild() {
  const newest = async (directory) => {
    let latest = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      latest = Math.max(latest, entry.isDirectory() ? await newest(path) : (await stat(path)).mtimeMs);
    }
    return latest;
  };
  const built = await stat(resolve("lib/client.js")).then((info) => info.mtimeMs).catch(() => 0);
  if (!built) {
    console.error("\nlib/client.js is missing — run `npm run build` first.\n");
    process.exit(2);
  }
  if (await newest(resolve("src")) > built) {
    console.error("\nlib/ is older than src/ — run `npm run build` first; a stale bundle is served from disk.\n");
    process.exit(2);
  }
}
await assertFreshBuild();

const home = await mkdtemp(join(tmpdir(), "dsh-works-selftest-"));
process.env.DSH_HOME = home;

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
}

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const { apply } = await import("../lib/index.js");
const routes = [];
/**
 * The real host mounts the route inside a cordis fiber effect and ignores what
 * `apply` returns — a returned disposer is dropped, which is exactly what used
 * to leak the route on disable and break the next activation. This stand-in
 * therefore hands the plugin an `effect` and keeps what that effect returns.
 */
let dispose = () => {};
apply({
  webRuntime: { trustedHosts: [] },
  webServer: {
    register: (route) => {
      routes.push(route);
      return () => {
        const at = routes.indexOf(route);
        if (at >= 0) routes.splice(at, 1);
      };
    },
  },
  effect: (execute) => {
    dispose = execute();
  },
});

const server = createServer((req, res) => void routes[0].handler(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}/api/dsh-helloai-works`;

const call = async (path, init) => {
  const response = await fetch(base + path, init);
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, response };
};
const post = (path, payload) =>
  call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}) });

/** A card with a single text block, for the conflict pass. */
const card = (id, title, text) => ({
  id,
  title,
  tags: [],
  source: "",
  blocks: [{ id: `${id}-b`, kind: "text", text }],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

try {
  /* ---------------- 1. Host: store + HTTP ---------------- */
  console.log("\n[1] host half over HTTP");

  check("registers exactly one prefix route", routes.length === 1 && routes[0].kind === "prefix", JSON.stringify(routes.map((r) => r.path)));
  check("route lives under /api/dsh-helloai-works", routes[0].path === "/api/dsh-helloai-works");

  const empty = await call("/state");
  check("GET /state answers ok", empty.status === 200 && empty.body.ok === true);
  check("starts with an empty collection", empty.body.doc.cards.length === 0 && empty.body.doc.tags.length === 0);
  check("reports its storage root", String(empty.body.root).includes("helloai-works"), empty.body.root);

  const now = new Date().toISOString();
  const doc = {
    version: 1,
    revision: 1,
    updatedAt: now,
    tags: [{ id: "tagresearch", name: "研究" }],
    cards: [
      {
        id: "cardone",
        title: "第一篇资料",
        tags: ["tagresearch"],
        source: "https://example.com/a",
        blocks: [
          { id: "b1", kind: "text", text: "正文第一段" },
          { id: "b2", kind: "text", text: "正文第二段" },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
  };
  const saved = await post("/save", { doc });
  check("POST /save accepts a document", saved.status === 200 && saved.body.revision === 2, JSON.stringify(saved.body));

  const upload = await post("/asset", { data: `data:image/png;base64,${PNG_1PX}`, mime: "image/png" });
  check("POST /asset stores an image", upload.status === 200 && /^[a-f0-9]{40}$/.test(upload.body.id), JSON.stringify(upload.body));
  check("asset is content-addressed and typed as PNG", upload.body.ext === "png" && upload.body.bytes > 0, JSON.stringify(upload.body));

  const again = await post("/asset", { data: `data:image/png;base64,${PNG_1PX}`, mime: "image/png" });
  check("the same image is deduplicated", again.body.id === upload.body.id);

  const image = await fetch(`${base}/asset/${upload.body.id}`);
  check("GET /asset streams the bytes back", image.status === 200 && image.headers.get("content-type") === "image/png");
  check("asset bytes round-trip exactly", Buffer.from(await image.arrayBuffer()).toString("base64") === PNG_1PX);

  const withImage = structuredClone(doc);
  withImage.cards[0].blocks.push({ id: "b3", kind: "image", asset: upload.body.id, caption: "配图" });
  const saved2 = await post("/save", { doc: withImage });
  check("saving an image block bumps the revision again", saved2.body.revision === 3);

  const relisted = await call("/state");
  check("state reports the stored asset", (relisted.body.assets || []).includes(upload.body.id));
  check("card survives the round-trip with 3 blocks", relisted.body.doc.cards[0].blocks.length === 3);

  const rejected = await post("/save", {
    doc: { tags: [{ id: "t", name: "x" }], cards: [{ id: "c", tags: ["unknown"], blocks: [{ id: "b", kind: "image", asset: "../../etc/passwd" }] }] },
  });
  check("save still succeeds but sanitises hostile input", rejected.status === 200);
  const after = await call("/state");
  check("unknown tag ids are dropped", after.body.doc.cards[0].tags.length === 0);
  check("non-asset image references are dropped", after.body.doc.cards[0].blocks.length === 0);

  await post("/save", { doc: withImage });

  /* ---- optimistic locking ---- */
  const before = (await call("/state")).body.revision;
  const variant = structuredClone(withImage);
  variant.cards[0].title = "改过的标题";

  const stale = await post("/save", { doc: variant, baseRevision: before - 1 });
  check("a stale base revision is refused with 409", stale.status === 409 && stale.body.code === "error.works.conflict", JSON.stringify(stale.body));
  check("the conflict carries the stored document", stale.body.revision === before && Array.isArray(stale.body.doc?.cards));
  check("the refused save did not touch the document", (await call("/state")).body.doc.cards[0].title === "第一篇资料");

  const fresh = await post("/save", { doc: variant, baseRevision: before });
  check("a matching base revision is accepted", fresh.status === 200 && fresh.body.revision === before + 1, JSON.stringify(fresh.body));

  const noop = await post("/save", { doc: variant, baseRevision: before + 1 });
  check("an unchanged document does not burn a revision", noop.status === 200 && noop.body.revision === before + 1, JSON.stringify(noop.body));

  const legacy = await post("/save", { doc: withImage });
  check("a save without a base revision stays accepted", legacy.status === 200 && legacy.body.revision === before + 2, JSON.stringify(legacy.body));

  /* ---- backup surface ---- */
  await post("/save", { doc: withImage });

  const exported = await post("/export");
  check("POST /export writes a file", exported.status === 200 && exported.body.bytes > 0, JSON.stringify(exported.body));
  check("export is a full backup", String(exported.body.filename).startsWith("works-full-"), exported.body.filename);
  check("export inlines the referenced image", exported.body.assets === 1, String(exported.body.assets));

  const head = await fetch(`${base}/download?name=${encodeURIComponent(exported.body.filename)}&offset=0&length=64`);
  const chunk = Buffer.from(await head.arrayBuffer());
  check("GET /download serves the first chunk", head.status === 200 && chunk.length === 64);
  check("download reports the total size", Number(head.headers.get("x-dsh-works-total")) === exported.body.bytes);

  const backups = await call("/backups");
  check("GET /backups lists the export", (backups.body.records || []).some((record) => record.name === exported.body.filename));
  check("backups also list an automatic snapshot", (backups.body.records || []).some((record) => record.kind === "snapshot"));

  const payload = JSON.parse(await readFile(exported.body.path, "utf8"));
  check("export payload carries its format marker", payload.format === "dsh-helloai-works");
  check("export payload carries the image bytes", typeof payload.assets[upload.body.id]?.data === "string");

  await post("/save", { doc: { version: 1, tags: [], cards: [] } });
  check("collection can be emptied", (await call("/state")).body.doc.cards.length === 0);

  const imported = await post("/import", { payload });
  check("POST /import restores the cards", imported.status === 200 && imported.body.cards === 1, JSON.stringify(imported.body));
  const restored = await call("/state");
  check("restored card still references its image", restored.body.doc.cards[0]?.blocks.some((block) => block.kind === "image"));
  check("restored image is served again", (await fetch(`${base}/asset/${upload.body.id}`)).status === 200);

  const collect = await post("/collect", {});
  check("POST /collect keeps referenced images", collect.body.removed === 0 && collect.body.kept === 1, JSON.stringify(collect.body));

  const snapshot = backups.body.records.find((record) => record.kind === "snapshot");
  check("a snapshot can be restored", (await post("/backups/restore", { name: snapshot.name })).status === 200);
  check("a backup can be deleted", (await post("/backups/delete", { name: snapshot.name })).body.deleted === snapshot.name);
  check("path traversal in a backup name is refused", (await post("/backups/delete", { name: "../../works.json" })).status === 400);

  check("unknown routes answer 404", (await call("/nope")).status === 404);
  check("GET on a POST-only route answers 405", (await call("/save")).status === 405);

  /* ---------------- 2. Client: module load + render ---------------- */
  console.log("\n[2] client half through the module loader");

  let entry;
  globalThis.window = {
    __ModuleLoader__: { load: (value) => (entry = value) },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  // The client half warms its store as it applies (`worksStore.start()`), which
  // is a `fetch` in flight before any later section gets a say. Stand a documents
  // service in for the whole section instead of leaving that request to fail: the
  // built-in retry ladder would otherwise keep failing for seconds and land a
  // "load failed" emit in the middle of section 4, where it drops the edits that
  // section has just made and turns the run red at random.
  const clientFetches = [];
  globalThis.fetch = async (input) => {
    clientFetches.push(typeof input === "string" ? input : String(input));
    return {
      ok: true,
      status: 200,
      // A fresh object per call: a shared one would let a late response overwrite
      // the document a later section loaded, through the store's identity check.
      json: async () => ({ ok: true, doc: { version: 1, revision: 1, updatedAt: new Date().toISOString(), tags: [], cards: [] }, assets: [], root: "", docPath: "" }),
    };
  };
  await import("../lib/client.js");
  check("registers itself with window.__ModuleLoader__", Boolean(entry));
  check("declares the package id", entry.id === "@hello-heyongping/dsh-helloai-works", entry?.id);

  const React = require("react");
  const jsxRuntime = require("react/jsx-runtime");
  const exportsObject = entry.factory((name) => {
    if (name === "react") return React;
    if (name === "react/jsx-runtime") return jsxRuntime;
    throw new Error(`unexpected require: ${name}`);
  });
  check("exports apply()", typeof exportsObject.apply === "function");
  check(
    "declares the services it injects",
    JSON.stringify(exportsObject.inject) === JSON.stringify(["slots", "locale", "sidebarRight", "sidebarRightTabs"]),
    JSON.stringify(exportsObject.inject),
  );

  const registrations = [];
  const tabTypes = [];
  // Keep what the plugin registers with the locale service, so the dictionaries
  // themselves — not just the markup that reads them — can be checked.
  const dictionaries = {};
  // The `@` pipeline lives in a sibling client package; this stand-in records
  // what the plugin registers with it.
  const triggerSources = [];
  const injectedDependencies = [];
  const fakeContext = {
    effect: (run) => run(),
    get: (name) => (name === "inputTriggers" ? { registerSource: (source) => (triggerSources.push(source), () => {}) } : undefined),
    // cordis runs the callback once the named services exist; here they always do.
    inject: (dependencies, callback) => (injectedDependencies.push(...dependencies), callback(fakeContext), () => {}),
    // Service-registration events: the last-resort attach path for `@`.
    on: () => () => {},
    locale: {
      register: (namespace, dictionary) => ((dictionaries[namespace] = dictionary), () => {}),
      bind: () => (key) => key,
    },
    slots: {
      inject: (_name, factory) => factory(),
      register: (options, component) => (registrations.push({ options, component }), () => {}),
    },
    sidebarRightTabs: { register: (definition) => (tabTypes.push(definition), () => {}) },
    sidebarRight: { openTab: () => undefined },
  };
  exportsObject.apply(fakeContext);
  // Drain the microtask queue: anything this section started must be fully
  // settled here, so nothing of it can still be in flight when a later section
  // starts editing the same store.
  await new Promise((resolve) => setImmediate(resolve));

  const byName = (name) => registrations.find((item) => item.options.name === name);
  const panel = byName("sidebar.panellist");
  const page = byName("main");
  const body = byName("sidebar.right.pane.tab");
  const chip = byName("sidebar.right.pane.tab.title");

  // Six seats: the sidebar row, the page it selects, the per-reply collect action
  // and the overlay its draft dialog rides, plus the card tab's body and chip.
  const seatNames = registrations.map((item) => item.options.name).sort();
  check(
    "registers six seats",
    JSON.stringify(seatNames) === JSON.stringify([
      "conversation.chat.assistant-actions",
      "main",
      "shell.overlay",
      "sidebar.panellist",
      "sidebar.right.pane.tab",
      "sidebar.right.pane.tab.title",
    ]),
    JSON.stringify(seatNames),
  );
  check("sidebar row sits directly under Plugins (order 0 < 1 < 10)", panel.options.order === 1, String(panel?.options.order));
  check("sidebar row and page share one id", panel.options.id === "helloai-works" && page.options.key === "helloai-works");
  check("locale namespace is declared everywhere", registrations.every((item) => item.options.locale === "helloai-works"));
  check("the page receives its opener through inject", typeof page.options.inject === "function");

  check("declares one right-Sidebar tab type", tabTypes.length === 1 && tabTypes[0].kind === "helloaiWorksCard", JSON.stringify(tabTypes));
  check("tab type is identified by package id", tabTypes[0].id === "@hello-heyongping/dsh-helloai-works/card", tabTypes[0].id);
  check("tab body and chip are keyed by the same type id", body.options.key === tabTypes[0].id && chip.options.key === tabTypes[0].id);
  // The `@` menu: one source, registered with the shipped trigger pipeline and
  // joining the `@` trigger rather than claiming a character of its own.
  check(
    "registers one @ source for cards",
    triggerSources.length === 1 && triggerSources[0].trigger === "@" && triggerSources[0].name === "works-card",
    JSON.stringify(triggerSources.map((source) => `${source.trigger}${source.name}`)),
  );
  check(
    "the @ source carries candidates, a pick, a chip serializer and a chip opener",
    typeof triggerSources[0].candidates === "function"
      && typeof triggerSources[0].onPick === "function"
      && typeof triggerSources[0].codec?.serialize === "function"
      && typeof triggerSources[0].codec?.clipboardText === "function"
      && typeof triggerSources[0].openReference === "function",
  );
  check(
    "the @ source keeps the menu's own group title out of the way",
    triggerSources[0].showGroupTitle === false,
  );
  // The menu sorts sources by `order`, the shipped file/session source sits at
  // 0, and a list below the fold is a feature nobody finds.
  check("the @ source asks to be listed above the shipped ones", triggerSources[0].order === -1, String(triggerSources[0].order));
  // The menu polls every source per keystroke and a synchronous throw aborts the
  // whole roster — every group, including the shipped ones, would spin forever.
  // A hostile request must therefore yield "no rows", never an exception.
  for (const hostile of [undefined, {}, { query: undefined }, { query: 42 }, { query: "x" }]) {
    let threw = null;
    try {
      await triggerSources[0].candidates({ sessionId: "s" }, hostile);
    } catch (error) {
      threw = error;
    }
    check(`an odd request (${JSON.stringify(hostile)}) returns rows, never throws`, threw === null, String(threw));
  }
  // The regression that matters most: the pipeline settles a source with
  // `source.candidates(...).then(...)`, so an answer that is not a Promise throws
  // *inside* the fetch loop — the loop stops there and every group, shipped ones
  // included, keeps its loading skeleton and shows no rows at all. A source that
  // is `async` satisfies this on every path, the empty case included.
  const answered = triggerSources[0].candidates({ sessionId: "s" }, { query: "" });
  check(
    "the @ candidates answer with a Promise, not a bare array (the menu chains it)",
    answered !== null && typeof answered?.then === "function",
    Object.prototype.toString.call(answered),
  );
  check("the promised answer settles into an array of rows", Array.isArray(await answered), Object.prototype.toString.call(await answered));
  let pickThrew = null;
  try {
    triggerSources[0].onPick({});
    triggerSources[0].onPick({ candidate: {} });
  } catch (error) {
    pickThrew = error;
  }
  check("a malformed pick inserts nothing instead of throwing", pickThrew === null, String(pickThrew));
  check(
    "the trigger pipeline is taken from the first path that already has it",
    injectedDependencies.length === 0 && triggerSources.length === 1,
    `inject calls: ${JSON.stringify(injectedDependencies)}`,
  );
  // A DSH that ships no trigger pipeline must still get the whole plugin: no
  // path attaches, nothing throws, and the panel says the feature is off.
  let degradedFailure = null;
  try {
    exportsObject.apply({
      ...fakeContext,
      get: () => undefined,
      inject: (dependencies, callback) => (callback({ ...fakeContext, get: () => undefined }), () => {}),
    });
  } catch (error) {
    degradedFailure = error;
  }
  check("the plugin still applies when the trigger pipeline is absent", degradedFailure === null, String(degradedFailure));
  check("nothing was registered against a pipeline that is not there", triggerSources.length === 1);

  const render = (element) => require("react-dom/server").renderToStaticMarkup(element);
  const t = (key) => key;

  // Line two of the header names `@` in its standing copy, so nothing extra is
  // drawn while the menu is live; the warning line is reserved for the session
  // where the pipeline is missing, which is the one a user can report back.
  const liveHeader = render(React.createElement(page.component, { t, openCard: () => {} }));
  check(
    "the header copy names the @ menu and adds no status line while it is live",
    liveHeader.includes('class="hxw-subtitle"') && !liveHeader.includes('class="hxw-hint"'),
    liveHeader.slice(liveHeader.indexOf("hxw-heading"), liveHeader.indexOf("</header>")),
  );
  exportsObject.cardSourceState.ready = false;
  const offHeader = render(React.createElement(page.component, { t, openCard: () => {} }));
  check(
    "the panel says so when the @ menu could not be wired up",
    offHeader.includes('class="hxw-hint"') && offHeader.includes(">mentionHintOff<"),
  );
  exportsObject.cardSourceState.ready = true;

  const panelHtml = render(React.createElement(page.component, { t, openCard: () => {} }));
  // Mounting the panel wakes the store, and that request must go through this
  // section's stand-in. A relative URL reaching the process's own `fetch` cannot
  // resolve, and the store's retry ladder would then spend seconds failing before
  // landing a "load failed" emit — the timing window that made this suite flaky.
  await new Promise((resolve) => setImmediate(resolve));
  check(
    "every request this section makes goes to the documents API, none escapes to the network",
    clientFetches.length > 0 && clientFetches.every((url) => url.startsWith("/api/dsh-helloai-works/")),
    JSON.stringify(clientFetches),
  );
  check("the panel renders its shell", panelHtml.includes("hxw-root") && panelHtml.includes("hxw-head"));
  check("the panel ships its theme-aware stylesheet", panelHtml.includes("--dsw-alias-label-primary") && panelHtml.includes("--dsw-alias-interactive-bg-hover"));
  check("the panel exposes the tag rail and the card list", panelHtml.includes("hxw-tags") && panelHtml.includes("hxw-list"));
  // The HelloAI family header: kicker with its version badge on line one, then
  // one faint sentence on line two — the `@` status only ever joins it as the
  // warning shown when the menu is unavailable.
  check("the header carries the family kicker and version badge", panelHtml.includes("HELLOAI | CARD RECORD") && panelHtml.includes("hxw-kicker") && panelHtml.includes("hxw-version"), panelHtml.slice(panelHtml.indexOf("hxw-heading"), panelHtml.indexOf("hxw-heading") + 220));
  const headRow2 = panelHtml.slice(panelHtml.indexOf('class="hxw-head-row hxw-head-row-sub"'), panelHtml.indexOf("</header>"));
  check(
    "the header keeps to two lines: brand+version, then one faint subtitle",
    (panelHtml.match(/class="hxw-head-row[ "]/g) ?? []).length === 2
      && headRow2.includes('class="hxw-subtitle"')
      && !headRow2.includes("hxw-sub-sep")
      && !headRow2.includes('class="hxw-hint"'),
    headRow2,
  );
  check(
    "the subtitle is inked a step lighter than the brand, and that ink is a token",
    panelHtml.includes(".hxw-subtitle{color:var(--hxw-text-3)"),
    panelHtml.slice(panelHtml.indexOf(".hxw-subtitle"), panelHtml.indexOf(".hxw-subtitle") + 90),
  );
  // The three header actions are drawn, not typed: a window with a plus for 新建,
  // stacked copies for 备份, a floppy for 保存 — each with its word still beside it,
  // so the row reads the same in either language. The word sits in a <span> so the
  // narrow-panel rule can drop it and keep the header at two lines.
  // Anchor on the markup, not on the stylesheet, which mentions `hxw-actions`
  // long before the element does.
  const headerActions = panelHtml.slice(panelHtml.indexOf('class="hxw-actions"'), panelHtml.indexOf("</header>"));
  const actionWord = (key) => headerActions.includes(`>${key}</span>`);
  check(
    "the header actions are 新建 / 备份 / 保存, each with its own drawn glyph",
    headerActions.includes('data-icon="new"') && actionWord("newCard")
      && headerActions.includes('data-icon="backup"') && actionWord("backupLabel")
      && headerActions.includes('data-icon="save"') && actionWord("save"),
    headerActions.slice(0, 200),
  );
  check(
    "every header-action glyph is painted with currentColor and carries its own 16px box",
    (headerActions.match(/<svg /g) ?? []).length === 3
      && (headerActions.match(/fill="currentColor"/g) ?? []).length === 6
      && (headerActions.match(/width="16" height="16"/g) ?? []).length === 3,
    headerActions.replace(/<path[^>]*>/g, "<path…>"),
  );
  // All three share one standard — a border with no fill, and the highlight only
  // under the pointer. `hxw-primary` is the filled accent treatment, so its
  // absence here is what keeps 新建 from shouting louder than 保存.
  check("the three header actions share one rest state: no filled variant", !headerActions.includes("hxw-primary"), headerActions.slice(0, 160));
  check(
    "the header actions are border-only at rest and highlight on hover",
    panelHtml.includes(".hxw-actions .hxw-btn{background:transparent}")
      && panelHtml.includes(".hxw-btn:hover:not(:disabled){background:var(--hxw-hover)"),
  );

  const tabInfo = { tab: { id: "tab-1", navigation: { params: { cardId: "missing-card" } } } };
  const bodyHtml = render(React.createElement(body.component, { t, useTabInfo: () => tabInfo }));
  check("the tab body renders a card surface", bodyHtml.includes("hxw-cv"));
  check("the tab body keeps the rounded-image stylesheet", bodyHtml.includes("border-radius:14px"));
  check("an unknown card id degrades to an empty state", bodyHtml.includes("hxw-cv-empty"));
  check("the chip falls back to a placeholder title", render(React.createElement(chip.component, { t, useTabInfo: () => tabInfo })).includes("hxw-chip-title"));

  const icon = render(React.createElement(panel.component, { size: 18, active: true }));
  check("the sidebar glyph renders at the requested size", icon.includes('width="18"') && icon.includes("currentColor"));

  // The backups drawer carries the data guide: where the collection lives, how a
  // picture is stored and compressed, what each backup kind holds, and what
  // survives an uninstall. Rendered directly, because the drawer is closed until
  // someone opens it.
  const drawerHtml = render(React.createElement(exportsObject.DataDrawer, { t, onClose: () => {} }));
  check("the backups drawer renders", drawerHtml.includes("hxw-drawer") && drawerHtml.includes("hxw-drawer-body"));
  check(
    "the storage panel still shows the paths and the backup tools",
    drawerHtml.includes("hxw-paths") && drawerHtml.includes("hxw-toolbar") && drawerHtml.includes(">backupsEmpty<"),
  );
  check("the storage panel points at the data guide", drawerHtml.includes(">helpHint<"));
  const guideTag = /<details[^>]*class="hxw-help"[^>]*>/.exec(drawerHtml)?.[0] ?? "";
  check("the data guide is open by default, not collapsed", guideTag.includes("open"), guideTag);
  const guideSections = ["helpWhere", "helpImages", "helpCompress", "helpFull", "helpUninstall", "helpRestore", "helpProtect"];
  check(
    "the guide answers all seven questions",
    guideSections.every((key) => drawerHtml.includes(`<h3>${key}</h3>`)),
    guideSections.filter((key) => !drawerHtml.includes(`<h3>${key}</h3>`)).join(","),
  );
  check(
    "every guide question carries its answer",
    guideSections.every((key) => drawerHtml.includes(`<p>${key}Body</p>`)),
    guideSections.filter((key) => !drawerHtml.includes(`<p>${key}Body</p>`)).join(","),
  );
  // The guide is prose, so it only counts if both dictionaries actually carry it
  // — and if the two languages stayed in step with each other everywhere else.
  const guideTerms = [...drawerHtml.matchAll(/<h3>(\w+)<\/h3>/g)].map((match) => match[1]);
  const guideBodies = [...drawerHtml.matchAll(/<p>(\w+)<\/p>/g)].map((match) => match[1]);
  const zhDict = dictionaries["helloai-works"]?.zh ?? {};
  const enDict = dictionaries["helloai-works"]?.en ?? {};
  const written = (key, min) => typeof zhDict[key] === "string" && zhDict[key].length > min && typeof enDict[key] === "string" && enDict[key].length > min;
  check(
    "every line of the data guide is written in both languages",
    guideTerms.length === 7
      && guideBodies.length === 7
      && guideTerms.every((key) => written(key, 3))
      && guideBodies.every((key) => written(key, 20)),
    [...guideTerms, ...guideBodies].filter((key) => !written(key, 3) || !written(key, 20)).join(","),
  );
  const zhKeys = Object.keys(zhDict).sort();
  const enKeys = Object.keys(enDict).sort();
  check(
    "both dictionaries define exactly the same keys",
    zhKeys.length > 60 && JSON.stringify(zhKeys) === JSON.stringify(enKeys),
    `zh-only: ${zhKeys.filter((key) => !enKeys.includes(key)).join(",")} | en-only: ${enKeys.filter((key) => !zhKeys.includes(key)).join(",")}`,
  );

  // The insert policy for pictures: max width 1500 px, aspect kept, PNG stays
  // PNG so its alpha survives, and anything already inside the budget is left
  // alone byte for byte.
  const planImage = exportsObject.planImage;
  check("the client exposes its picture policy as a test seam", typeof planImage === "function");
  const bigPhoto = planImage({ width: 6000, mime: "image/jpeg" });
  check("a 6000 px photo scales to 1500 px wide", bigPhoto.reencode === true && Math.abs(bigPhoto.scale - 0.25) < 1e-9, JSON.stringify(bigPhoto));
  check("the scale is one number for both edges, so the aspect ratio holds", Math.abs(6000 * bigPhoto.scale - 1500) < 1e-9 && Math.abs(4000 * bigPhoto.scale - 1000) < 1e-9);
  const atBudget = planImage({ width: 1500, mime: "image/jpeg" });
  check("a picture exactly at 1500 px keeps its bytes", atBudget.reencode === false && atBudget.scale === 1, JSON.stringify(atBudget));
  const insideBudget = planImage({ width: 800, mime: "image/jpeg" });
  check("a picture inside the budget is never re-encoded", insideBudget.reencode === false && insideBudget.scale === 1);
  const bigPng = planImage({ width: 4000, mime: "image/png" });
  check("a downscaled PNG stays PNG, so transparency survives", bigPng.reencode === true && bigPng.mime === "image/png" && Math.abs(bigPng.scale - 0.375) < 1e-9, JSON.stringify(bigPng));
  check("a downscaled WebP stays WebP", planImage({ width: 3000, mime: "image/webp" }).mime === "image/webp");
  check("a downscaled BMP becomes JPEG", planImage({ width: 3000, mime: "image/bmp" }).mime === "image/jpeg");
  const gif = planImage({ width: 5000, mime: "image/gif" });
  check("an animated GIF is never re-encoded", gif.reencode === false && gif.scale === 1 && gif.mime === "image/gif");
  check("an SVG is never re-encoded", planImage({ width: 5000, mime: "image/svg+xml" }).reencode === false);
  const undeclared = planImage({ width: 4000, mime: "" });
  check("an undeclared type is handled as PNG, which keeps its alpha", undeclared.mime === "image/png" && undeclared.reencode === true);

  // "Follow the DSH theme" is a claim worth checking, not just asserting: a
  // colour property may only reach a raw literal through a token fallback.
  const hardCodedColour = /(?:^|[;{])\s*(?:background|background-color|color|border-color|border|outline-color)\s*:\s*(?:#|rgb|hsl)/i;
  const css = panelHtml + bodyHtml;
  check(
    "no colour property is hard-coded — every one resolves through a token",
    !hardCodedColour.test(css),
    css.match(hardCodedColour)?.[0]?.trim(),
  );
  check(
    "both surfaces derive their accent from a --dsw-* alias",
    panelHtml.includes("--hxw-accent:var(--dsw-alias-state-business-primary") && bodyHtml.includes("--hxw-accent:var(--dsw-alias-state-business-primary"),
  );
  const tokensUsed = new Set(css.match(/--dsw-[a-z0-9-]+/g) ?? []);
  check("the two stylesheets consume a real spread of theme tokens", tokensUsed.size >= 12, `${tokensUsed.size} distinct tokens`);

  /* ---------------- 3. Save conflicts, through the real store ---------------- */
  console.log("\n[3] save conflicts, driven through the client store");

  const API_PREFIX = "/api/dsh-helloai-works";
  // The bundle fetches a relative API path, which Node cannot resolve: route it
  // to this test's socket. The native implementation was captured before section
  // 2 stood its own stand-in up, so the chain never passes through that one.
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    return nativeFetch(url.startsWith(API_PREFIX) ? base + url.slice(API_PREFIX.length) : url, init);
  };

  const store = exportsObject.worksStore;
  check("the client exposes its store as a test seam", Boolean(store));
  store.setTranslate((key, params) => `${key}${params ? ` ${JSON.stringify(params)}` : ""}`);

  await store.reload();
  const loaded = store.getSnapshot();
  check("the store loads the document from the Host", loaded.doc !== null && loaded.loading === false && loaded.conflict === null);
  check("the store remembers the storage paths", String(loaded.root).includes("helloai-works") && String(loaded.docPath).endsWith("works.json"));

  // Another window writes first, moving the revision under us.
  const otherDoc = structuredClone(loaded.doc);
  otherDoc.cards.push(card("fromother", "别的窗口写的", "x"));
  const otherSave = await post("/save", { doc: otherDoc });
  check("another writer moves the revision", otherSave.status === 200, JSON.stringify(otherSave.body));

  // This page edits on top of its now-stale base.
  const localBefore = store.getSnapshot().doc.cards.length;
  store.mutate((doc) => ({ ...doc, cards: [...doc.cards, card("fromhere", "本窗口写的", "y")] }));
  await store.flush();

  const conflicted = store.getSnapshot();
  check("a stale save raises a conflict instead of clobbering", conflicted.conflict !== null, JSON.stringify(conflicted.conflict));
  check("the conflict reports the stored revision", conflicted.conflict?.revision === otherSave.body.revision, JSON.stringify(conflicted.conflict));
  check("the notice offers both choices", conflicted.notice?.actions?.length === 2, JSON.stringify(conflicted.notice?.actions?.map((a) => a.label)));
  check("the local edit is preserved, not dropped", conflicted.doc.cards.length === localBefore + 1);
  check(
    "nothing was written while the conflict stood",
    (await call("/state")).body.doc.cards.every((item) => item.id !== "fromhere"),
  );

  // Autosave must stay parked until the user decides.
  await store.flush();
  check("further autosaves stay parked while the conflict stands", store.getSnapshot().conflict !== null);

  await store.keepMine();
  const kept = store.getSnapshot();
  check("keeping mine clears the conflict and saves", kept.conflict === null && kept.saving === "saved", JSON.stringify({ conflict: kept.conflict, saving: kept.saving }));
  const afterKeep = await call("/state");
  check("keeping mine writes the local edit", afterKeep.body.doc.cards.some((item) => item.id === "fromhere"));
  check("keeping mine is an explicit overwrite of the other writer", afterKeep.body.doc.cards.every((item) => item.id !== "fromother"));

  // The other direction: adopt the stored copy and drop the local edits.
  const otherDoc2 = structuredClone(store.getSnapshot().doc);
  otherDoc2.cards.push(card("fromother2", "另一个窗口又写了", "z"));
  await post("/save", { doc: otherDoc2 });
  store.mutate((doc) => ({ ...doc, cards: doc.cards.map((item) => (item.id === "fromhere" ? { ...item, title: "本窗口改的" } : item)) }));
  await store.flush();
  check("a second conflict is detected too", store.getSnapshot().conflict !== null);

  await store.takeTheirs();
  const adopted = store.getSnapshot();
  check("taking theirs clears the conflict", adopted.conflict === null);
  check("taking theirs adopts the stored document", adopted.doc.cards.some((item) => item.id === "fromother2"));
  check("taking theirs discards the local edit", !adopted.doc.cards.some((item) => item.title === "本窗口改的"));
  check("the stored document is untouched by the discarded edit", (await call("/state")).body.doc.cards.every((item) => item.title !== "本窗口改的"));

  /* ---------------- 4. Tag and card editing, through the store ---------------- */
  console.log("\n[4] tag and card editing");

  // Start from an empty document so each assertion below is unambiguous.
  await post("/save", { doc: { version: 1, revision: 1, updatedAt: new Date().toISOString(), tags: [], cards: [] } });
  await store.reload();
  check("editing starts from an empty collection", store.getSnapshot().doc.cards.length === 0 && store.getSnapshot().doc.tags.length === 0);

  const tagA = store.addTag("研究");
  const tagB = store.addTag("待读");
  const tagAgain = store.addTag("研究");
  await store.flush();
  let current = (await call("/state")).body.doc;
  check("addTag creates tags", current.tags.length === 2, JSON.stringify(current.tags));
  check("addTag reuses an existing name rather than duplicating it", tagAgain === tagA && current.tags.length === 2);

  check("renameTag reports a rename", store.renameTag(tagB, "稍后读") === "renamed");
  await store.flush();
  current = (await call("/state")).body.doc;
  check("a rename reaches the host", current.tags.find((tag) => tag.id === tagB)?.name === "稍后读", JSON.stringify(current.tags));

  check("renameTag refuses an empty name", store.renameTag(tagB, "   ") === "empty");
  check("a refused rename leaves the tag alone", store.getSnapshot().doc.tags.find((tag) => tag.id === tagB)?.name === "稍后读");

  const cardA = store.createCard(tagA);
  store.updateCard(cardA, { title: "第一篇", source: "https://example.com" });
  store.changeBlocks(cardA, (blocks) => [...blocks, { id: "extratextblock", kind: "text", text: "第二段" }]);
  await store.flush();
  current = (await call("/state")).body.doc;
  const storedA = current.cards.find((item) => item.id === cardA);
  check("title, source and blocks all persist", storedA?.title === "第一篇" && storedA?.source === "https://example.com" && storedA?.blocks.length === 2, JSON.stringify(storedA));
  check("a new card inherits the selected tag", storedA?.tags.includes(tagA) === true, JSON.stringify(storedA?.tags));

  store.toggleCardTag(cardA, tagB);
  await store.flush();
  current = (await call("/state")).body.doc;
  check("a card can carry two tags", current.cards.find((item) => item.id === cardA)?.tags.length === 2);

  /* ---- reading: the tag rail, the order and the search box ---- */

  // Searching is one index built per document and one scan per keystroke; these
  // checks pin down that the index still means exactly what the old per-field
  // scan meant, field by field.
  const client = exportsObject;
  const docNow = store.getSnapshot().doc;
  const indexNow = client.buildSearchIndex(docNow);
  const orderedNow = client.selectCards(docNow, { activeTag: null, sortDesc: true });
  const hits = (needle) => client.searchCards(orderedNow, needle, indexNow).length;
  check("the list holds the whole collection", orderedNow.length === docNow.cards.length && orderedNow.length === 1);
  check("a title is searchable", hits("第一篇") === 1);
  check("a source is searchable", hits("example.com") === 1);
  check("a text block is searchable", hits("第二段") === 1);
  check("a tag name is searchable", hits("稍后读") === 1, JSON.stringify(docNow.tags));
  check("the search ignores case", hits("EXAMPLE.COM") === 1);
  check("a needle nothing contains matches nothing", hits("zzz-没有这个词") === 0);
  check("an empty needle keeps every card", client.searchCards(orderedNow, "  ", indexNow).length === 1);
  check("the tag rail filters the list", client.selectCards(docNow, { activeTag: tagA, sortDesc: true }).length === 1);
  check("an unknown tag selects nothing", client.selectCards(docNow, { activeTag: "no-such-tag", sortDesc: true }).length === 0);
  check("the untagged bucket is its own selection", client.selectCards(docNow, { activeTag: client.UNTAGGED, sortDesc: true }).length === 0);

  // The index joins a card's fields with a newline, so a needle can never match
  // by running off the end of one field and into the next.
  const seamDoc = {
    version: 1,
    revision: 1,
    updatedAt: new Date().toISOString(),
    tags: [{ id: "tseam", name: "标签" }],
    cards: [
      { id: "cseam", title: "汉字ABC", tags: ["tseam"], source: "DEF汉字", blocks: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "corder1", title: "中间", tags: [], source: "", blocks: [{ id: "b", kind: "text", text: "正文" }], createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" },
      { id: "corder2", title: "最新", tags: [], source: "", blocks: [], createdAt: "2026-03-01T00:00:00.000Z", updatedAt: "2026-03-01T00:00:00.000Z" },
    ],
  };
  const seamIndex = client.buildSearchIndex(seamDoc);
  check("a needle cannot match across two fields", client.searchCards(seamDoc.cards, "abcdef", seamIndex).length === 0);
  check("…while each field still matches on its own", client.searchCards(seamDoc.cards, "abc", seamIndex).length === 1 && client.searchCards(seamDoc.cards, "def", seamIndex).length === 1);
  const newestFirst = client.selectCards(seamDoc, { activeTag: null, sortDesc: true }).map((card) => card.id);
  const oldestFirst = client.selectCards(seamDoc, { activeTag: null, sortDesc: false }).map((card) => card.id);
  check("newest first is the default order", JSON.stringify(newestFirst) === JSON.stringify(["corder2", "corder1", "cseam"]), JSON.stringify(newestFirst));
  check("the sort toggle reverses it", JSON.stringify(oldestFirst) === JSON.stringify(["cseam", "corder1", "corder2"]), JSON.stringify(oldestFirst));
  check("the untagged bucket finds the card without tags", client.selectCards(seamDoc, { activeTag: client.UNTAGGED, sortDesc: true }).length === 2);

  /* ---- `@` references to the collection, from the composer ---- */

  // The prompt text is the payload here, so this source is driven with the real
  // dictionary rather than the key-echo translate used for structural checks.
  const zhText = (key) => dictionaries["helloai-works"]?.zh?.[key] ?? key;
  const opened = [];
  const cardSource = client.createCardSource({ t: zhText, openCard: (cardId) => opened.push(cardId) });
  const cardRows = (list) => list.filter((row) => !String(row.value).startsWith("tag:"));

  const rows = await cardSource.candidates({ sessionId: "s" }, { query: "" });
  check("the @ menu lists the collection's cards", cardRows(rows).length === 1 && cardRows(rows)[0].value === cardA, JSON.stringify(rows));
  check(
    "each row carries the card title, a hint and its section",
    cardRows(rows)[0].name === "第一篇" && cardRows(rows)[0].section === "卡片资料" && cardRows(rows)[0].description.includes("研究"),
    JSON.stringify(cardRows(rows)[0]),
  );
  check("typing after @ searches the card's text", cardRows(await cardSource.candidates({ sessionId: "s" }, { query: "第二段" }))[0]?.value === cardA);
  check("typing a tag name finds the card too", cardRows(await cardSource.candidates({ sessionId: "s" }, { query: "稍后读" })).length === 1);
  check("a query nothing matches lists no rows", (await cardSource.candidates({ sessionId: "s" }, { query: "zzz-没有这个词" })).length === 0);

  const pick = cardSource.onPick({ candidate: cardRows(rows)[0], session: { sessionId: "s" }, action: "pick" });
  check(
    "picking a card inserts one chip pointing back at it",
    pick?.insert?.source === "works-card"
      && pick.insert.ref === cardA
      && pick.insert.label === "第一篇"
      && pick.insert.clipboardText === "@第一篇",
    JSON.stringify(pick),
  );
  check("a chip for a card that is already gone inserts nothing", cardSource.onPick({ candidate: { name: "x", value: "gone" }, session: { sessionId: "s" } }) === undefined);

  const signal = new AbortController().signal;
  const serialized = await cardSource.codec.serialize(cardA, signal);
  check(
    "the chip serializes into the card's own text for the model",
    serialized.startsWith("【卡片资料：第一篇】") && serialized.includes("标签：研究") && serialized.includes("第二段"),
    serialized.slice(0, 90),
  );
  check(
    "the serialized card carries its source and collected date",
    serialized.includes("来源：https://example.com") && /\d{4}-\d{2}-\d{2}/.test(serialized),
    serialized.slice(0, 200),
  );
  const vanished = await cardSource.codec.serialize("gone", signal);
  check("a card deleted before submit still sends, with a notice instead", !vanished.includes("第二段") && vanished.includes("引用的卡片已不存在"), vanished);
  check("the chip's clipboard form reads like a mention", cardSource.codec.clipboardText(cardA) === "@第一篇");
  check("clicking a chip opens that card", cardSource.openReference({ sessionId: "s" }, { ref: cardA }) === true && opened[0] === cardA);
  check("clicking a chip for a card that is gone opens nothing", cardSource.openReference({ sessionId: "s" }, { ref: "gone" }) === false);

  const hugeCard = {
    id: "huge",
    title: "长卡片",
    tags: [],
    source: "",
    blocks: [{ id: "b", kind: "text", text: "字".repeat(20_000) }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const hugeText = client.cardPromptText(hugeCard, null, zhText);
  check("an oversized card is truncated instead of flooding the prompt", hugeText.length < 20_000 && hugeText.includes("截断"), String(hugeText.length));

  const cardCopy = store.duplicateCard(cardA, "（副本）");
  await store.flush();
  current = (await call("/state")).body.doc;
  const copy = current.cards.find((item) => item.id === cardCopy);
  check("duplicateCard produces a second card", current.cards.length === 2);
  check("the copy keeps the content and marks itself", copy?.title === "第一篇（副本）" && copy?.blocks.length === 2 && copy?.source === "https://example.com", JSON.stringify(copy));
  check("the copy shares no block identity with the original", copy.blocks.every((block) => !storedA.blocks.some((other) => other.id === block.id)));
  check("the copy sits directly after the original", current.cards[current.cards.findIndex((item) => item.id === cardA) + 1]?.id === cardCopy);

  check("renaming onto an existing name reports a merge", store.renameTag(tagB, "研究") === "merged");
  await store.flush();
  current = (await call("/state")).body.doc;
  check("the merged-away tag is gone", !current.tags.some((tag) => tag.id === tagB), JSON.stringify(current.tags));
  check("its cards moved to the surviving tag", current.cards.every((item) => item.tags.every((id) => id === tagA)), JSON.stringify(current.cards.map((item) => item.tags)));

  store.deleteCard(cardCopy);
  await store.flush();
  current = (await call("/state")).body.doc;
  check("deleteCard removes exactly one card", current.cards.length === 1 && current.cards[0].id === cardA, JSON.stringify(current.cards.map((item) => item.id)));

  store.deleteTag(tagA);
  await store.flush();
  current = (await call("/state")).body.doc;
  check("deleteTag removes the tag", current.tags.length === 0);
  check("deleteTag keeps the cards and unfiles them", current.cards.length === 1 && current.cards[0].tags.length === 0);

  const populated = render(React.createElement(page.component, { t, openCard: () => {} }));
  check("a populated panel offers tag actions", populated.includes("hxw-tag-tools"));
  check("a populated panel offers per-card actions", populated.includes("hxw-card-tools") && populated.includes("hxw-card-open") && populated.includes("hxw-card-body"));
  check("each list row carries exactly the copy and delete actions", populated.includes('title="duplicateCard"') && populated.includes('title="deleteCard"'));
  // The row tools are round glyph buttons, not labelled pills: one card here, so
  // exactly two of them, each carrying its own colour variant and accessible name.
  check(
    "the row actions are two drawn, labelled icon buttons",
    (populated.match(/class="hxw-icon-btn"/g) ?? []).length === 2
      && populated.includes('data-variant="copy"') && populated.includes('data-variant="danger"')
      && populated.includes('title="duplicateCard"') && populated.includes('title="deleteCard"')
      && populated.includes('aria-label="duplicateCard"') && populated.includes('aria-label="deleteCard"'),
    populated.slice(populated.indexOf("hxw-card-tools"), populated.indexOf("hxw-card-tools") + 260),
  );
  const openCardHtml = render(React.createElement(body.component, { t, useTabInfo: () => ({ tab: { id: "tab-x", navigation: { params: { cardId: cardA } } } }) }));
  check("the open card offers an editable collected date", openCardHtml.includes("hxw-cv-collected") && openCardHtml.includes('type="date"'));
  // 来源 is optional, so it rides the collected-date row as a drawn glyph instead
  // of taking a field row of its own: the card body belongs to the tags and the
  // blocks, and the input exists only once the icon is clicked.
  const metaHtml = openCardHtml.slice(openCardHtml.indexOf('class="hxw-cv-meta"'), openCardHtml.indexOf('class="hxw-cv-body"'));
  const metaOrder = [metaHtml.indexOf("hxw-cv-collected"), metaHtml.indexOf("hxw-src-btn"), metaHtml.indexOf("hxw-save")];
  check(
    "来源 sits between the collected date and the save state",
    metaOrder[0] >= 0 && metaOrder[0] < metaOrder[1] && metaOrder[1] < metaOrder[2],
    JSON.stringify(metaOrder),
  );
  check(
    "来源 is drawn, not typed, and takes the theme's ink",
    openCardHtml.includes('data-icon="source"') && openCardHtml.includes('aria-label="source"') && openCardHtml.includes('stroke="currentColor"'),
  );
  // Anchored on the markup, not the stylesheet: the rule for the editor is in
  // `CARD_CSS`, so an unqualified name would match the stylesheet itself.
  check("来源 holds no space until it is clicked", !openCardHtml.includes('class="hxw-source-input"'));
  check("no field row was left behind for 来源", !openCardHtml.includes("<label>source</label>"));
  check(
    "a card that carries a source marks its icon and reads it out on hover",
    openCardHtml.includes('data-on="true"') && openCardHtml.includes('title="https://example.com"'),
  );
  // Row actions live in the list only: a second copy here is what made delete feel duplicated.
  check("the open card carries no row actions of its own", !openCardHtml.includes("hxw-icon-btn") && !openCardHtml.includes('title="deleteCard"') && !openCardHtml.includes('title="duplicateCard"'), openCardHtml.slice(openCardHtml.indexOf("hxw-cv-meta"), openCardHtml.indexOf("hxw-cv-meta") + 260));
  // The other side of the same rule: no source, no accent — the glyph is all there is.
  const blankCard = store.createCard(null);
  const blankHtml = render(React.createElement(body.component, { t, useTabInfo: () => ({ tab: { id: "tab-y", navigation: { params: { cardId: blankCard } } } }) }));
  check("a card with no source keeps its 来源 icon quiet", blankHtml.includes('data-on="false"') && blankHtml.includes('title="source"'));

  /* ---- a whole tag group as one reference ---- */

  // Filed last on purpose: this adds cards, so every count-based check above has
  // already had its say.
  const groupTag = store.addTag("人物");
  store.toggleCardTag(cardA, groupTag);
  store.toggleCardTag(blankCard, groupTag);

  const groupRows = await cardSource.candidates({ sessionId: "s" }, { query: "人物" });
  const tagRow = groupRows.find((row) => String(row.value).startsWith("tag:"));
  check(
    "a tag shows up in @ as a whole-group reference",
    tagRow?.value === `tag:${groupTag}`
      && tagRow.section === "标签分组"
      && tagRow.description === "2 张卡片 · 整组引用"
      && tagRow.icon === "folder",
    JSON.stringify(groupRows),
  );
  const tagPick = cardSource.onPick({ candidate: tagRow, session: { sessionId: "s" } });
  check(
    "picking a tag inserts one group chip",
    tagPick?.insert?.source === "works-card"
      && tagPick.insert.ref === `tag:${groupTag}`
      && tagPick.insert.label === "人物"
      && tagPick.insert.clipboardText === "@人物",
    JSON.stringify(tagPick),
  );
  check("clicking a group chip opens nothing", cardSource.openReference({ sessionId: "s" }, { ref: `tag:${groupTag}` }) === false);

  const groupText = await cardSource.codec.serialize(`tag:${groupTag}`, signal);
  check(
    "the group chip expands to every card filed under that tag",
    groupText.startsWith("【卡片资料：标签「人物」共 2 张卡片】")
      && groupText.includes("【卡片资料：第一篇】")
      && groupText.includes("【卡片资料：未命名】"),
    groupText.slice(0, 200),
  );
  check("the group expansion stays inside its own budget", groupText.length < client.MAX_GROUP_PROMPT_CHARS + 400, String(groupText.length));
  check("a chip for a deleted tag still sends, with a notice", (await cardSource.codec.serialize("tag:gone", signal)).includes("引用的标签已不存在"));
  check(
    "an empty tag expands to a note, not an empty prompt",
    client.groupPromptText({ id: "t", name: "空" }, [], store.getSnapshot().doc, zhText).includes("下还没有卡片"),
  );

  globalThis.fetch = nativeFetch;
} finally {
  await new Promise((resolve) => server.close(resolve));
  dispose();
  await rm(home, { recursive: true, force: true });
}

/* ---------------- 5. Lifecycle: the route belongs to the fiber ---------------- */
check("disposing the fiber releases the prefix route", routes.length === 0, JSON.stringify(routes.map((route) => route.path)));

console.log(failures ? `\n${failures} check(s) failed\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);
