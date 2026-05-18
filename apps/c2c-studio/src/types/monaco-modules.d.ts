// monaco-editor exports the same public surface from its ESM subpaths as from
// the package root, but the package's `exports` map only typechecks the root.
// These ambient declarations bridge the subpaths used by dynamic imports in
// `src/lib/editor/lazyMonaco.ts` so TypeScript can resolve them under
// `moduleResolution: "bundler"`.

declare module "monaco-editor/esm/vs/editor/editor.api" {
  export * from "monaco-editor";
}

declare module "monaco-editor/esm/vs/basic-languages/java/java.contribution";
declare module "monaco-editor/esm/vs/basic-languages/xml/xml.contribution";
declare module "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
declare module "monaco-editor/esm/vs/language/json/monaco.contribution";

declare module "monaco-editor/esm/vs/editor/editor.worker.js";
declare module "monaco-editor/esm/vs/language/json/json.worker.js";
