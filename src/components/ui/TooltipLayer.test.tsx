import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { TooltipLayer } from './TooltipLayer';

/**
 * The app's tooltip replaces the browser's. It must follow React when a
 * title changes or goes away — it used to keep the first text it saw, so a
 * "why is this disabled" note stayed after the button was enabled, and the
 * browser's own tooltip appeared on top with the new text.
 */
const Harness = () => {
  const [title, setTitle] = useState<string | undefined>('Switch to dark theme');
  return (
    <>
      <TooltipLayer />
      <button title={title}>Theme</button>
      <button onClick={() => setTitle('Switch to light theme')}>change</button>
      <button onClick={() => setTitle(undefined)}>clear</button>
    </>
  );
};

const tooltip = () => document.getElementById('app-tooltip')?.textContent ?? null;

describe('TooltipLayer', () => {
  it('shows the current title, follows changes, and drops a removed one', () => {
    render(<Harness />);
    const target = screen.getByText('Theme');
    fireEvent.mouseOver(target);
    expect(tooltip()).toBe('Switch to dark theme');
    expect(target.getAttribute('title')).toBeNull(); // the browser draws nothing of its own
    fireEvent.mouseOut(target);

    act(() => { screen.getByText('change').click(); });
    fireEvent.mouseOver(target);
    expect(tooltip()).toBe('Switch to light theme');
    expect(target.getAttribute('title')).toBeNull();
    fireEvent.mouseOut(target);

    act(() => { screen.getByText('clear').click(); });
    fireEvent.mouseOver(target);
    expect(tooltip()).toBeNull();
  });
});
