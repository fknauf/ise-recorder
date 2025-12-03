import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import stylistic from "@stylistic/eslint-plugin";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts"
  ]),
  {
    plugins: {
      "@stylistic": stylistic
    },
    rules: {
      "arrow-body-style": "warn",
      "@stylistic/array-bracket-newline": [ "warn", { multiline: true } ],
      "@stylistic/arrow-parens": [ "warn", "as-needed" ],
      "@stylistic/block-spacing": "warn",
      "@stylistic/brace-style": "warn",
      "@stylistic/comma-dangle": "warn",
      "@stylistic/comma-spacing": "warn",
      "@stylistic/comma-style": "warn",
      "@stylistic/curly-newline": [ "warn", { consistent: true } ],
      "@stylistic/dot-location": [ "warn", "property" ],
      "@stylistic/eol-last": "warn",
      "@stylistic/function-call-spacing": "warn",
      "@stylistic/generator-star-spacing": [ "warn", { before: false, after: true } ],
      "@stylistic/indent": [ "warn", 2 ],
      "@stylistic/jsx-child-element-spacing": "warn",
      "@stylistic/jsx-closing-bracket-location": "warn",
      "@stylistic/jsx-closing-tag-location": "warn",
      "@stylistic/jsx-curly-brace-presence": "warn",
      "@stylistic/jsx-curly-newline": "warn",
      "@stylistic/jsx-curly-spacing": "warn",
      "@stylistic/jsx-equals-spacing": "warn",
      "@stylistic/jsx-first-prop-new-line": "warn",
      "@stylistic/jsx-function-call-newline": "warn",
      "@stylistic/jsx-indent-props": [ "warn", 2 ],
      "@stylistic/jsx-max-props-per-line": [ "warn", { maximum: 5 } ],
      "@stylistic/jsx-pascal-case": "warn",
      "@stylistic/jsx-quotes": "warn",
      "@stylistic/jsx-self-closing-comp": "warn",
      "@stylistic/jsx-tag-spacing": [
        "warn",
        {
          closingSlash: "never",
          beforeSelfClosing: "never",
          afterOpening: "never",
          beforeClosing: "never"
        }
      ],
      //      "@stylistic/jsx-wrap-multilines": "warn",
      "@stylistic/key-spacing": "warn",
      "@stylistic/keyword-spacing": [
        "warn",
        {
          overrides: {
            if: { after: false },
            for: { after: false },
            while: { after: false },
            switch: { after: false }
          }
        }
      ],
      "@stylistic/linebreak-style": [ "warn", "unix" ],
      "@stylistic/lines-between-class-members": [
        "warn",
        {
          enforce: [
            { blankLine: "always", prev: "method", next: "*" },
            { blankLine: "always", prev: "*", next: "method" }
          ]
        }
      ],
      "@stylistic/max-statements-per-line": "warn",
      "@stylistic/member-delimiter-style": [
        "warn",
        {
          multiline: {
            delimiter: "none"
          }
        }
      ],
      "@stylistic/max-statements-per-line": "warn",
      "@stylistic/multiline-ternary": [ "warn", "always-multiline" ],
      "@stylistic/new-parens": "warn",
      "@stylistic/newline-per-chained-call": "warn",
      "@stylistic/no-confusing-arrow": "warn",
      "@stylistic/no-extra-parens": "warn",
      "@stylistic/no-extra-semi": "warn",
      "@stylistic/no-floating-decimal": "warn",
      "@stylistic/no-mixed-spaces-and-tabs": "warn",
      "@stylistic/no-multi-spaces": "warn",
      "@stylistic/no-multiple-empty-lines": "warn",
      "@stylistic/no-tabs": "warn",
      "@stylistic/no-trailing-spaces": "warn",
      "@stylistic/no-whitespace-before-property": "warn",
      "@stylistic/nonblock-statement-body-position": "warn",
      "@stylistic/object-curly-newline": "warn",
      "@stylistic/object-curly-spacing": [ "warn", "always" ],
      "@stylistic/one-var-declaration-per-line": "warn",
      "@stylistic/operator-linebreak": "warn",
      "@stylistic/padded-blocks": [ "warn", "never" ],
      "@stylistic/quote-props": [ "warn", "consistent-as-needed" ],
      "@stylistic/quotes": [ "warn", "double", { avoidEscape: true } ],
      "@stylistic/rest-spread-spacing": "warn",
      "@stylistic/semi": "error",
      "@stylistic/semi-spacing": "warn",
      "@stylistic/semi-style": "warn",
      "@stylistic/space-before-blocks": "warn",
      "@stylistic/space-before-function-paren": [ "warn", { named: "never", asyncArrow: "always", catch: "never" } ],
      "@stylistic/space-in-parens": "warn",
      "@stylistic/space-infix-ops": "warn",
      "@stylistic/space-unary-ops": "warn",
      "@stylistic/spaced-comment": [ "warn", "always", { exceptions: [ "/", "*" ] } ],
      "@stylistic/switch-colon-spacing": "warn",
      "@stylistic/template-curly-spacing": "warn",
      "@stylistic/template-tag-spacing": "warn",
      "@stylistic/type-annotation-spacing": "warn",
      "@stylistic/type-generic-spacing": "warn",
      "@stylistic/type-named-tuple-spacing": "warn",
      "@stylistic/wrap-iife": "warn",
      "@stylistic/wrap-regex": "warn",
      "@stylistic/yield-star-spacing": [ "warn", "after" ]
    }
  }
]);

export default eslintConfig;
