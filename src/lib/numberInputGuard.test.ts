// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { installNumberInputGuard } from './numberInputGuard';

describe('installNumberInputGuard', () => {
  installNumberInputGuard(document);

  it('takes focus off a number box when the wheel turns, so scrolling cannot change it', () => {
    const input = document.createElement('input');
    input.type = 'number';
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);
    document.dispatchEvent(new WheelEvent('wheel'));
    expect(document.activeElement).not.toBe(input);
  });

  it('refuses "e" and "+" in a number box, and leaves other inputs alone', () => {
    const num = document.createElement('input');
    num.type = 'number';
    const text = document.createElement('input');
    document.body.append(num, text);
    const press = (el: HTMLElement, key: string) => {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(press(num, 'e')).toBe(true);
    expect(press(num, '+')).toBe(true);
    expect(press(num, '5')).toBe(false);
    expect(press(text, 'e')).toBe(false);
  });
});
