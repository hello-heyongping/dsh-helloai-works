/**
 * How the collection scales — `node scripts/bench.mjs [cards…]`.
 *
 * dsh-helloai-works keeps the whole document in one JSON file and the whole
 * document in the browser, so three numbers decide how it feels as the
 * collection grows:
 *
 *   1. how big `works.json` gets (bytes on disk, and the load/save payload),
 *   2. how long the Host and the page spend turning it into objects and back,
 *   3. how long one keystroke in the search box takes.
 *
 * Pictures never enter these numbers: they live in `assets/` as ordinary files
 * and are fetched by the browser as images, so only `backups/works-full-*.json`
 * carries their bytes (printed separately, bottom of the table).
 *
 * This is a measurement, not a test — nothing here fails.
 */
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/* ---------------- the client bundle, with no browser around it ---------------- */
let entry;
globalThis.window = { __ModuleLoader__: { load: (value) => (entry = value) }, setTimeout, clearTimeout };
await import("../lib/client.js");
const client = entry.factory((name) => {
  if (name === "react") return require("react");
  if (name === "react/jsx-runtime") return require("react/jsx-runtime");
  throw new Error(`unexpected require: ${name}`);
});
const { buildSearchIndex, selectCards, searchCards } = client;

/* ---------------- a synthetic collection ---------------- */

const TAG_NAMES = ["研究", "待读", "灵感", "工作", "生活"];
const PARAGRAPH =
  "这是一段大约两百字的正文，用来代表真实卡片里的记录。资料卡片把文字与图片按块排列，" +
  "每张卡片通常是一篇文章的摘录、一段读书笔记或者一份会议记录的开头部分。";

/** One document that looks like a real one: 2 text blocks + 1 picture per card. */
function makeDoc(size) {
  const tags = TAG_NAMES.map((name, index) => ({ id: `tag${index}`, name }));
  const cards = [];
  for (let i = 0; i < size; i += 1) {
    const at = new Date(Date.now() - i * 60_000).toISOString();
    cards.push({
      id: `card-${i}-${(i * 7919).toString(36)}`,
      title: `第 ${i + 1} 篇资料的标题`,
      tags: [tags[i % tags.length].id, ...(i % 7 === 0 ? [tags[(i + 2) % tags.length].id] : [])],
      source: `https://example.com/notes/${i}`,
      blocks: [
        { id: `b${i}-1`, kind: "text", text: PARAGRAPH },
        { id: `b${i}-2`, kind: "text", text: `${PARAGRAPH.slice(0, 90)}编号 ${i}` },
        { id: `b${i}-3`, kind: "image", asset: "0123456789abcdef0123456789abcdef01234567", caption: `配图 ${i}` },
      ],
      createdAt: at,
      updatedAt: at,
    });
  }
  return { version: 1, revision: size, updatedAt: new Date().toISOString(), tags, cards };
}

/* ---------------- timing ---------------- */

/** Median of `runs`, in milliseconds — steadier than a single sample. */
function time(runs, task) {
  task();
  const samples = [];
  for (let i = 0; i < runs; i += 1) {
    const started = performance.now();
    task();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const ms = (value) => `${value < 0.05 ? "<0.1" : value.toFixed(value < 10 ? 1 : 0)} ms`;
const mb = (bytes) => `${(bytes / 1048576).toFixed(2)} MB`;

/**
 * What the search box used to do on every keystroke: lower-case each field of
 * each card again. Kept here as the "before" column.
 */
function legacySearch(cards, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return cards;
  return cards.filter((card) => {
    if (card.title.toLowerCase().includes(needle)) return true;
    if (card.source.toLowerCase().includes(needle)) return true;
    if (card.blocks.some((block) => (block.kind === "text" ? block.text : block.caption).toLowerCase().includes(needle))) return true;
    return card.tags.some((tagId) => tagId.toLowerCase().includes(needle));
  });
}

/* ---------------- run ---------------- */

const asked = process.argv.slice(2).map(Number).filter((value) => Number.isFinite(value) && value > 0);
const sizes = asked.length ? asked : [500, 2000, 5000, 20_000];

console.log("\n每张卡片：2 段文字（约 300 字）+ 1 张图片引用");
console.log("图片字节不在 works.json 里，因此不计入下面的文档体积");
console.log("搜索用最坏情况的针：一个哪张卡片都不含的词（不给任何短路机会）\n");
console.log("| 卡片数 | works.json | 首次加载解析 | 每次保存序列化 | 建索引 | 切换标签排序 | 按键搜索（新） | 按键搜索（旧） | 命中 1 张（新） | 列表行数 |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

for (const size of sizes) {
  const doc = makeDoc(size);
  const serialized = JSON.stringify(doc);
  const bytes = Buffer.byteLength(serialized);

  const parse = time(5, () => JSON.parse(serialized));
  const stringify = time(5, () => JSON.stringify(doc));
  const indexMs = time(9, () => buildSearchIndex(doc));
  const ordered = selectCards(doc, { activeTag: null, sortDesc: true });
  const sortMs = time(9, () => selectCards(doc, { activeTag: null, sortDesc: true }));
  const index = buildSearchIndex(doc);

  // A needle nothing matches is the worst case for both implementations: no
  // card can short-circuit, so every field is examined.
  const missing = "zzz-no-such-text-anywhere";
  const rare = `编号 ${Math.floor(size / 2)}`;
  const mine = time(9, () => searchCards(ordered, missing, index));
  const theirs = time(5, () => legacySearch(ordered, missing));
  const rareMs = time(9, () => searchCards(ordered, rare, index));
  const rareHits = searchCards(ordered, rare, index).length;
  const missingHits = searchCards(ordered, missing, index).length;

  console.log(
    `| ${size.toLocaleString("en-US")} | ${mb(bytes)} | ${ms(parse)} | ${ms(stringify)} | ${ms(indexMs)} | ${ms(sortMs)} | ${ms(mine)} | ${ms(theirs)} | ${ms(rareMs)} | ${ordered.length.toLocaleString("en-US")} |`,
  );

  if (size === sizes[sizes.length - 1]) {
    // Sanity: the index must still mean what the old scan meant.
    console.log(`\n最后一次搜索：无命中词命中 ${missingHits} 张（应为 0），“${rare}” 命中 ${rareHits} 张（应为 1）。`);
  }
}

console.log("\n完整备份（图文一个文件，图片按 base64 内联，体积约 +37%）：");
console.log("（按 1500 px JPEG 压缩后每张约 300 KB 估算）");
for (const pictures of [200, 500, 2000, 5000]) {
  const pictureBytes = pictures * 300 * 1024;
  console.log(`  ${String(pictures).padStart(5)} 张图片 ≈ ${mb(pictureBytes * 1.37)} 的 works-full-*.json`);
}
console.log("\n提示：完整备份只在「生成完整备份 / 下载 / 导入」时读写，日常查看和搜索完全不碰它。");
