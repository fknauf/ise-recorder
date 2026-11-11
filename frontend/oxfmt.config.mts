import { defineConfig } from "oxfmt";

export default defineConfig({
  $schema: "./node_modules/oxfmt/configuration_schema.json",
  ignorePatterns: [],
  sortImports: {
    newlinesBetween: false,
  },
});
