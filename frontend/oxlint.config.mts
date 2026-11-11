import { defineConfig } from "oxlint";
// Import { oxlint } from 'oxc-config-mantine';

export default defineConfig({
  //  ...oxlint,
  ignorePatterns: ["**/*.{mjs,cjs,js,d.ts,d.mts}", ".next"],

  plugins: ["typescript", "unicorn", "import", "react"],

  categories: {
    correctness: "error",
  },
});
