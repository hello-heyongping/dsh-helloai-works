/**
 * Focused check of the exact mechanism that hung the `@` menu.
 *
 * The shipped `InputTriggerController.fetchCandidates` settles a source with
 *
 *     source.candidates(projection, request).then(onSettled, onFailed)
 *
 * so a source answering with a plain array throws a TypeError *inside* that loop:
 * the loop aborts there, `source-settled` is never reduced, and every group
 * behind it keeps `status: "pending"` — which MenuView renders as two skeleton
 * rows and nothing else. That is the reported "menu stuck on skeletons".
 *
 * This drives both shapes through that same code path: a synchronous source (the
 * broken contract) and the plugin's own `createCardSource` (the fixed one).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const React = require("react");

// Load the built client half the way the browser does.
let entry;
globalThis.window = {
  __ModuleLoader__: { load: (value) => (entry = value) },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};
await import("../lib/client.js");
const client = entry.factory((name) => {
  if (name === "react") return React;
  if (name === "react/jsx-runtime") return require("react/jsx-runtime");
  throw new Error(`unexpected require: ${name}`);
});

/** Menu groups as the shipped reducer seeds them: every group starts pending. */
const seedGroups = (sources) => sources.map((source) => ({ source: source.name, status: "pending", items: [] }));

/**
 * The shipped fetch loop, verbatim in shape and order: every source is asked and
 * its answer is chained. Whatever throws here is what the real controller would
 * throw out of `track()`, with the menu already open.
 */
function fetchCandidates(groups, sources, projection, request, log) {
  for (const source of sources) {
    source.candidates(projection, request).then(
      (items) => {
        const group = groups.find((item) => item.source === source.name);
        group.status = "ready";
        group.items = items ?? [];
        log(`${source.name}: settled with ${group.items.length} row(s)`);
      },
      (error) => {
        const group = groups.find((item) => item.source === source.name);
        group.status = "failed";
        log(`${source.name}: failed — ${error}`);
      },
    );
  }
}

const state = (groups) => JSON.stringify(groups.map((group) => [group.source, group.status, group.items.length]));

console.log("1) a source that answers with a bare array (the shape that hung the menu)");
{
  const broken = { trigger: "@", name: "works-card-without-promise", candidates: () => [{ name: "row", value: "1" }] };
  const shipped = { trigger: "@", name: "reference", candidates: async () => [{ name: "file.txt", value: "a" }] };
  const groups = seedGroups([broken, shipped]);
  let threw = null;
  try {
    fetchCandidates(groups, [broken, shipped], { sessionId: "s" }, { query: "" }, console.log);
  } catch (error) {
    threw = error;
  }
  console.log(`  threw inside the fetch loop: ${threw === null ? "no" : `${threw.constructor.name}: ${threw.message}`}`);
  console.log(`  groups after the loop: ${state(groups)}`);
  console.log("  -> the shipped source behind it was never even asked: skeleton rows, zero data\n");
}

console.log("2) the plugin's own @ source through the same loop");
{
  // Stand the collection up without the network: one card filed under one tag.
  const doc = {
    version: 1,
    revision: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
    tags: [{ id: "t1", name: "人物" }],
    cards: [
      {
        id: "c1",
        title: "林见微",
        tags: ["t1"],
        source: "",
        blocks: [{ id: "b1", kind: "text", text: "28 岁，旧城修复师。" }],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  const store = client.worksStore;
  store.start = () => {};
  store.getSnapshot = () => ({
    doc,
    assets: new Set(),
    loading: false,
    saving: "idle",
    savedAt: "",
    notice: null,
    conflict: null,
    activeCardId: null,
    inlineCardId: null,
    collect: null,
    root: "",
    docPath: "",
  });

  const source = client.createCardSource({ t: (key) => key, openCard: () => {} });
  const groups = seedGroups([source]);
  let threw = null;
  try {
    fetchCandidates(groups, [source], { sessionId: "s" }, { query: "" }, console.log);
  } catch (error) {
    threw = error;
  }
  console.log(`  threw inside the fetch loop: ${threw === null ? "no" : String(threw)}`);
  // The loop returns synchronously; the settlement lands on the microtask queue.
  await new Promise((resolve) => setTimeout(resolve, 20));
  console.log(`  groups after settling: ${state(groups)}`);
  console.log(`  rows offered: ${JSON.stringify(groups[0].items.map((item) => `${item.section}/${item.name}`))}`);
  console.log("  -> settled with rows, so the menu draws the list instead of skeletons");
}
