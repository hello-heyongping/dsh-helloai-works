import { access, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

/**
 * The workspace keeps one shared dev toolchain in `../dsh-helloai-bak/node_modules`,
 * so this plugin builds without its own `npm install`. A local esbuild (when the
 * plugin was installed standalone) always wins.
 */
async function loadEsbuild() {
  try {
    return await import("esbuild");
  } catch {
    return import("../../dsh-helloai-bak/node_modules/esbuild/lib/main.js");
  }
}
const { build } = await loadEsbuild();

// The version baked into the client badge comes from package.json alone: bump
// `version`, rebuild, and both halves agree without touching UI code.
const { version } = JSON.parse(await readFile(resolve("package.json"), "utf8"));

const output = resolve("lib");
const stage = resolve(`.helloai-works-build-${randomUUID()}`);
async function exists(path) { try { await access(path); return true; } catch { return false; } }

try {
  await build({
    entryPoints: ["src/index.ts", "src/store.ts"],
    outdir: stage,
    outbase: "src",
    bundle: false,
    format: "esm",
    platform: "node",
    target: "node20",
    sourcemap: true,
  });
  await build({
    entryPoints: ["src/client.tsx"],
    outfile: join(stage, "client.js"),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client"],
    minify: true,
    define: { "process.env.NODE_ENV": '"production"', __HELLOAI_WORKS_VERSION__: JSON.stringify(version) },
    banner: { js: "window.__ModuleLoader__.load({ id: \"@hello-heyongping/dsh-helloai-works\", factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;" },
    footer: { js: "return module.exports;\n} });" },
  });
  if (await exists(output)) await rm(output, { recursive: true, force: true });
  await rename(stage, output);
} finally {
  await rm(stage, { recursive: true, force: true });
}
console.log("[dsh-helloai-works] 已从 src 生成 Host 与客户端发布产物");
