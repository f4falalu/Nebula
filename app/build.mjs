// Builds Nebula's frontend.
//   node build.mjs        V1: dist/nebula.html for the claude.ai artifact. React and
//                         ReactDOM load from cdnjs (UMD globals); everything else is inlined.
//   node build.mjs --web  V2: dist/web/ (index.html + hashed assets) served by the
//                         FastAPI backend. React and Clerk are bundled from npm.
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, basename } from "node:path";

// styles.css first, then any other .css under src/ (one file per page area).
function allCss() {
  const cssFiles = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".css") && !p.endsWith("styles.css")) cssFiles.push(p); } };
  walk("src");
  return [readFileSync("src/ui/styles.css", "utf8"), ...cssFiles.sort().map((f) => readFileSync(f, "utf8"))].join("\n");
}

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">`;

if (process.argv.includes("--web")) {
  rmSync("dist/web", { recursive: true, force: true });
  mkdirSync("dist/web/assets", { recursive: true });
  const result = await esbuild.build({
    entryPoints: ["src/main-web.tsx"],
    bundle: true,
    format: "esm",
    splitting: true,
    outdir: "dist/web/assets",
    entryNames: "[name]-[hash]",
    chunkNames: "chunk-[hash]",
    minify: true,
    target: "es2020",
    jsx: "transform",
    jsxFactory: "React.createElement",
    jsxFragment: "React.Fragment",
    define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
    metafile: true,
    legalComments: "none",
    logLevel: "warning",
  });
  const entry = Object.entries(result.metafile.outputs).find(([, o]) => o.entryPoint === "src/main-web.tsx")[0];
  const css = allCss();
  const cssName = `app-${createHash("sha256").update(css).digest("hex").slice(0, 10)}.css`;
  writeFileSync(`dist/web/assets/${cssName}`, css);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Nebula Requisitions</title>
<meta name="description" content="Requisition lifecycle and fulfillment audit">
<meta name="theme-color" content="#0c6b58">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
${FONTS}
<link rel="stylesheet" href="/assets/${cssName}">
</head>
<body>
<div id="root"><div class="boot">Loading Nebula…</div></div>
<script type="module" src="/assets/${basename(entry)}"></script>
</body>
</html>
`;
  writeFileSync("dist/web/index.html", html);
  // Static files served as-is at the site root (PWA manifest and icon).
  for (const f of readdirSync("public")) writeFileSync(`dist/web/${f}`, readFileSync(`public/${f}`));
  const size = Object.values(result.metafile.outputs).reduce((s, o) => s + o.bytes, 0);
  console.log(`dist/web/ index.html + ${Object.keys(result.metafile.outputs).length} JS files (${(size / 1024).toFixed(0)} KB) + ${cssName}`);
  process.exit(0);
}

const globals = {
  react: "window.React",
  "react-dom": "window.ReactDOM",
  "react-dom/client": "window.ReactDOM",
};
const globalsPlugin = {
  name: "globals",
  setup(build) {
    build.onResolve({ filter: /^react(-dom)?(\/client)?$/ }, (a) => ({ path: a.path, namespace: "g" }));
    build.onLoad({ filter: /.*/, namespace: "g" }, (a) => ({ contents: `module.exports = ${globals[a.path]};`, loader: "js" }));
  },
};

const result = await esbuild.build({
  entryPoints: ["src/main.tsx"],
  bundle: true,
  format: "iife",
  minify: process.argv.includes("--minify") || true,
  target: "es2020",
  jsx: "transform",
  jsxFactory: "React.createElement",
  jsxFragment: "React.Fragment",
  write: false,
  plugins: [globalsPlugin],
  legalComments: "none",
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const css = allCss();
const html = `<title>Nebula Requisitions</title>
<meta name="claude:viewport-fit-sides" content="cover">
${FONTS}
<style>
${css}
</style>
<div id="root"><div class="boot">Loading Nebula…</div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js"></script>
<script>
${js}
</script>
`;
mkdirSync("dist", { recursive: true });
writeFileSync("dist/nebula.html", html);
console.log(`dist/nebula.html ${(html.length / 1024).toFixed(1)} KB`);
