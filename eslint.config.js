import typescriptEslint from "@typescript-eslint/eslint-plugin";
import unusedImports from "eslint-plugin-unused-imports";
import typescriptParser from "@typescript-eslint/parser";
import stylistic from "@stylistic/eslint-plugin";

export default [
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts", "examples/**/*.ts"],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module"
      }
    },
    plugins: {
      "@typescript-eslint": typescriptEslint,
      "unused-imports": unusedImports,
      "@stylistic": stylistic
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "error",
      "unused-imports/no-unused-imports": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "error",

      // clang-style control flow: braces only when the body needs them,
      // single statements go on their own line below the condition
      "curly": ["warn", "multi-or-nest", "consistent"],
      "@stylistic/nonblock-statement-body-position": ["warn", "below"],

      // breathing room after every control block
      "@stylistic/padding-line-between-statements": [
        "warn",
        { blankLine: "always", prev: ["if", "for", "while", "switch", "try"], next: "*" }
      ],

      // core formatting
      "@stylistic/indent": ["warn", 2, { SwitchCase: 1 }],
      "@stylistic/quotes": ["warn", "double", { avoidEscape: true }],
      "@stylistic/semi": ["warn", "always"],
      "@stylistic/comma-dangle": ["warn", "always-multiline"],
      "@stylistic/brace-style": ["warn", "1tbs", { allowSingleLine: true }],
      "@stylistic/object-curly-spacing": ["warn", "always"],
      "@stylistic/array-bracket-spacing": ["warn", "never"],
      "@stylistic/arrow-parens": ["warn", "always"],
      "@stylistic/keyword-spacing": "warn",
      "@stylistic/space-before-blocks": "warn",
      "@stylistic/space-infix-ops": "warn",
      "@stylistic/comma-spacing": "warn",
      "@stylistic/key-spacing": "warn",
      "@stylistic/no-multi-spaces": ["warn", { ignoreEOLComments: true }],
      "@stylistic/no-multiple-empty-lines": ["warn", { max: 1, maxBOF: 0, maxEOF: 0 }],
      "@stylistic/no-trailing-spaces": "warn",
      "@stylistic/padded-blocks": ["warn", "never"],
      "@stylistic/eol-last": "warn",
      "@stylistic/member-delimiter-style": "warn",
      "@stylistic/type-annotation-spacing": "warn"
    }
  }
];
