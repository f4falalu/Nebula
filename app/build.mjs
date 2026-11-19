// Builds the V1 single-page app into dist/nebula.html.
// React and ReactDOM load from cdnjs (UMD globals); everything else is inlined.
import * as esbuild from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
// styles.css first, then any other .css under src/ (one file per page area).
const cssFiles = [];
const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".css") && !p.endsWith("styles.css")) cssFiles.push(p); } };
walk("src");
const css = [readFileSync("src/ui/styles.css", "utf8"), ...cssFiles.sort().map((f) => readFileSync(f, "utf8"))].join("\n");
const html = `<title>Nebula Requisitions</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
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
