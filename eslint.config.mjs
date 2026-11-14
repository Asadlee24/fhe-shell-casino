import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "fhevmTemp/**",
      "frontend/.next/**",
      "frontend/next-env.d.ts",
      "tmp/**",
      ".coverage_artifacts/**",
      ".coverage_cache/**",
      ".coverage_contracts/**",
      "artifacts/**",
      "build/**",
      "cache/**",
      "coverage/**",
      "dist/**",
      "node_modules/**",
      "types/**",
      "*.env",
      "*.log",
      "coverage.json",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ["**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-inferrable-types": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "_", varsIgnorePattern: "_" },
      ],
    },
  },
  {
    files: ["hardhat.config.ts", "{deploy,tasks,test}/**/*.ts", "frontend/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./frontend/tsconfig.json"],
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreIIFE: true, ignoreVoid: true },
      ],
    },
  }
);
