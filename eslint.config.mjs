// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config (ESLint v9) for the Vite + React + TS frontend.
 *
 * Philosophy mirrors the backend config: lint with the *syntactic* recommended
 * sets, not the type-checked variants — `tsc -b` already enforces types, so
 * ESLint's value here is the React-specific correctness rules (rules-of-hooks,
 * fast-refresh boundaries) plus a thin layer of generic JS footguns.
 *
 * `react-hooks/rules-of-hooks` is kept at ERROR (calling a hook conditionally
 * is a genuine runtime bug). `exhaustive-deps` and the fast-refresh rule are
 * WARN — they flag real smells but also fire on deliberate, reviewed patterns
 * (stable refs intentionally omitted from deps; context files that co-export a
 * provider + its hook), so failing the build on them would punish correct code.
 */
export default tseslint.config(
  {
    // Build output + generated typings + the config/tooling files themselves.
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'vite.config.ts',
      'eslint.config.mjs',
      'src/vite-env.d.ts',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // React Hooks — the *classic* two rules only. We deliberately do NOT spread
      // react-hooks v7's `recommended-latest`, because that preset bundles the
      // new React-Compiler static analysis (set-state-in-effect, refs-in-render,
      // …) which fires as errors on ~100 ubiquitous, never-audited effect
      // patterns here. Those are perf/style advisories, not the correctness bug
      // that rules-of-hooks catches — enabling them wholesale would mean a huge
      // out-of-scope refactor. rules-of-hooks stays an error (conditional hook
      // calls are real runtime bugs); exhaustive-deps is advisory.
      'react-hooks/rules-of-hooks': 'error',
      // The browser's own pop-ups — they cannot be themed and print the host
      // name over whatever is asked. useConfirm()/usePrompt() exist instead.
      // A rule on the GLOBALS, so the app's own `confirm` from useConfirm()
      // (a local variable) is not affected, and a bare confirm('…') is caught,
      // which the text-matching test in no-native-dialogs.test.ts cannot tell apart.
      'no-restricted-globals': ['error',
        { name: 'alert', message: 'Use the app toast or useConfirm().' },
        { name: 'confirm', message: 'Use useConfirm() from ConfirmContext.' },
        { name: 'prompt', message: 'Use usePrompt() from ConfirmContext.' },
      ],
      'no-restricted-properties': ['error',
        { object: 'window', property: 'alert', message: 'Use the app toast or useConfirm().' },
        { object: 'window', property: 'confirm', message: 'Use useConfirm() from ConfirmContext.' },
        { object: 'window', property: 'prompt', message: 'Use usePrompt() from ConfirmContext.' },
      ],
      'react-hooks/exhaustive-deps': 'warn',
      // Vite fast-refresh boundary hint — advisory; co-exported hooks/consts are
      // common and reviewed in this codebase.
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // `any` is pervasive (API payloads, generic table cells) and tsc already
      // guards the typed surface; forbidding it would be churn without safety.
      '@typescript-eslint/no-explicit-any': 'off',
      // Unused vars are a smell, not a build-breaker; `_`-prefixed opt out.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Best-effort try/catch cleanup blocks are intentional.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Side-effect ternaries / short-circuits used as statements are an
      // intentional, readable toggle idiom here (e.g. `set.has(x) ? set.delete(x)
      // : set.add(x)`). Allow them; still flag truly dead expressions.
      '@typescript-eslint/no-unused-expressions': [
        'error',
        { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true },
      ],
      // `@ts-nocheck` lives in three WebRTC call hooks pending a typed cleanup
      // (tracked separately). Advisory for now so it doesn't block the build;
      // once the suppressions are removed this rule has nothing to report.
      '@typescript-eslint/ban-ts-comment': 'warn',
    },
  },
);
