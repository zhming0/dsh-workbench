import { defineConfig } from "tsdown";

const external = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-settings/client",
  "@deepseek-ai/dsh-client-runtime/client",
]);

export default defineConfig({
  entry: { client: "dist/client/index.js" },
  outDir: "dist",
  format: "cjs",
  platform: "browser",
  target: "es2023",
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier) => external.has(specifier),
    alwaysBundle: (specifier) => !external.has(specifier),
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV ?? "production",
    ),
  },
  outputOptions: {
    entryFileNames: "client.js",
    banner:
      'window.__ModuleLoader__.load({ id: "@zhming0/dsh-workbench", factory: (require) => {',
    footer: "return module.exports; } });",
    intro: "var module = { exports: {} }; var exports = module.exports;",
  },
});
