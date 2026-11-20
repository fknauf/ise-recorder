import { defineConfig } from "oxlint";
// Import { oxlint } from 'oxc-config-mantine';

export default defineConfig({
  //  ...oxlint,
  ignorePatterns: ["**/*.{mjs,cjs,js,d.ts,d.mts}", ".next"],

  plugins: ["typescript", "unicorn", "import", "react"],

  categories: {
    correctness: "error",
  },

  rules: {
    "react/capitalized-calls": "error",
    "react/invariant": "error",
    "react/hooks": "error",
    "react/memo-dependencies": "error",
    "react/rule-suppression": "error",
    "react/syntax": "error",
    "react/todo": "error",
    "react/unsupported-syntax": "error",
  },
});
