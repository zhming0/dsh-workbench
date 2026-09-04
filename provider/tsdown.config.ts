import { defineConfig } from "tsdown";

// The modules the dsh web shell shares with every plugin bundle
// (PLATFORM_MODULES in @deepseek-ai/dsh-client-modules). Anything else a
// bundle requires must be bundled in or declared under dsh.client.external.
const external = new Set([
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
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
