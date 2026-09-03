import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Build output and generated protobuf code are not sources anyone edits.
  { ignores: ["dist", "src/gen"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // The build config sits outside every tsconfig; lint it against a
          // minimal default project instead of skipping it.
          allowDefaultProject: ["tsdown.config.ts"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // A promise nothing awaits is an ordering bug waiting to happen, and a
      // promise passed where a value is expected never runs at all. UI event
      // handlers are exempted from the void-return check: they own their
      // rejections with in-component error state.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
      // `let` means "reassigned later"; `==` means "coerces on purpose".
      // Neither should appear without a reason a reader can see.
      eqeqeq: "error",
      "prefer-const": "error",
      // Every if/else/for/while body gets braces, even for one statement: an
      // unbraced body makes the next edit the next bug. Try/catch and
      // function bodies require braces in the language itself.
      curly: ["error", "all"],
      // An underscore prefix marks a slot the signature requires but the
      // body deliberately ignores, matching the runner's Go convention.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Methods implementing an async interface legitimately await nothing.
      "@typescript-eslint/require-await": "off",
    },
  },
  // dsh-client-runtime 0.1.1-rc.2 types `slots.register` through
  // @deepseek-ai/dsh-client-ui-slots without declaring it, so the liner sees
  // an error type where tsc (via skipLibCheck) sees nothing. Remove this
  // override when the upstream dependency declaration lands.
  {
    files: ["src/client/index.tsx"],
    rules: { "@typescript-eslint/no-unsafe-call": "off" },
  },
  // Config files carry no types, so switch off the type-aware rules for them.
  { files: ["**/*.js", "**/*.mjs", "**/*.cjs"], ...tseslint.configs.disableTypeChecked },
);
