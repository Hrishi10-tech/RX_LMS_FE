import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The browser's own alert / confirm / prompt cannot be themed and print
 * "localhost:5174 says" over whatever we ask — they look broken in a deployed
 * product. The app has its own: useConfirm() and usePrompt() (ConfirmContext).
 * This fails the build if a native one creeps back in.
 */
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(f) && !/\.test\./.test(f) ? [p] : [];
  });

describe('no native browser dialogs', () => {
  it('nothing calls window.alert / confirm / prompt', () => {
    const offenders: string[] = [];
    for (const file of walk(join(__dirname, '..'))) {
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '').trim();
        if (code.startsWith('*') || code.startsWith('/*')) return;
        // window.x(…) always; a bare alert/prompt only when handed a string —
        // the app's own usePrompt() is called with an options object.
        if (/window\.(?:alert|confirm|prompt)\s*\(/.test(code) || /(?:^|[^.\w])(?:alert|prompt)\s*\(\s*['"`]/.test(code)) {
          offenders.push(`${file.split('/src/')[1]}:${i + 1}: ${code}`);
        }
      });
    }
    expect(offenders, `use useConfirm()/usePrompt() instead:\n${offenders.join('\n')}`).toEqual([]);
  });

  // With `required`, `type="email"`, `min` and the like, the browser checks a
  // form before the app's submit handler runs and shows its own "Please fill
  // out this field" bubble — the app's message never appears. Every form opts
  // out and validates itself.
  it('every <form> has noValidate, so the browser never shows its own validation bubble', () => {
    const offenders: string[] = [];
    for (const file of walk(join(__dirname, '..'))) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/<form\b[^>]*>/g)) {
        if (!/\bnoValidate\b/.test(m[0])) {
          offenders.push(`${file.split('/src/')[1]}:${src.slice(0, m.index).split('\n').length}`);
        }
      }
    }
    expect(offenders, `add noValidate and check the fields in the submit handler:\n${offenders.join('\n')}`).toEqual([]);
  });
});
