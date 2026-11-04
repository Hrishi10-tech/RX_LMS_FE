import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';

/**
 * The item picker's SERVER-SIDE search — the one piece of this work the bash
 * suites cannot reach.
 *
 * `/inventory/options?search=` is covered at the API level, but nothing proved
 * the form actually CALLS it. That gap is not academic: the search box was
 * built once already and shipped unreachable, because every caller passed a
 * preselected `item` and the box is hidden in that case. An endpoint nobody
 * invokes and a box nobody can open both pass an API suite.
 *
 * What must hold:
 *   1. typing queries the SERVER, and sends the term
 *   2. it is debounced — a burst of keystrokes is one request, not five
 *   3. an item absent from `availableItems` becomes selectable once the
 *      server returns it (the whole point: the browser is not doing the
 *      filtering, so the client-side cap stops mattering)
 *   4. emptying the box falls back to the list the page supplied
 *   5. the "this list is not complete" notice is suppressed WHILE searching,
 *      because during a search it is false
 *   6. a preselected item hides the box and is offered even when it is not in
 *      `availableItems`
 */

/**
 * Routed by URL: the form also fetches /indents/my-claims once an item is
 * chosen, and a single catch-all mock feeds it the option-search payload,
 * which is not the shape it expects. `optionsGet` counts ONLY the picker's
 * calls, so the debounce assertion cannot be fooled by unrelated traffic.
 */
const optionsGet = vi.fn();
let optionsReply: any = { items: [] };
const get = vi.fn((url: string, cfg?: any) => {
  if (url === '/inventory/options') {
    optionsGet(url, cfg);
    return Promise.resolve({ data: { data: optionsReply } });
  }
  return Promise.resolve({ data: { data: [] } });
});
vi.mock('../../api', () => ({ client: { get: (...a: any[]) => (get as any)(...a) } }));
vi.mock('@/lib', () => ({
  cachedGet: vi.fn().mockResolvedValue([]),
  extractErrorMessage: (e: any) => String(e),
}));
// `confirm` is STABLE for the same reason AUTH below is: the form holds it
// across renders, and a fresh function each call would churn anything keyed
// on it. Resolves true so the BOM-duplicate prompt never blocks these specs,
// which are about the item picker, not that guard.
const CONFIRM = vi.fn().mockResolvedValue(true);
vi.mock('../../context', () => ({
  useToast: () => ({ addToast: vi.fn() }),
  useConfirm: () => CONFIRM,
}));
// The user object must be STABLE across renders. The form has
// `useEffect(..., [user])`, so a mock that builds a fresh object each call
// re-runs that effect on every render, which sets state, which renders again —
// the test process runs out of heap rather than failing an assertion.
const AUTH = { user: { id: 'u1', role: 'USER', departmentId: 'd1' } };
vi.mock('../../hooks', () => ({
  useAuth: () => AUTH,
  // RequestForm now takes its reference data from a shared hook (projects,
  // departments, user directory). These specs are about the item picker, so
  // the bootstrap is stubbed empty rather than mocked in detail.
  useFormBootstrap: () => ({ projects: [], departments: [], usersDirectory: [], failed: false }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../ui', () => ({
  UserMultiSelect: () => null,
  NumberInput: (p: any) => <input type="number" value={p.value ?? 1} onChange={() => {}} />,
}));

import { RequestForm } from './RequestForm';

const CAPPED = [{ id: 'a', name: 'Antenna', unit: 'NOS', stock: 5 }];
// Sorts late enough to fall outside a capped list — the class of item that
// used to be unfindable.
const BEYOND = { id: 'z', name: 'Zener Diode', unit: 'NOS', stock: 9 };

const options = () => screen.getAllByRole('option').map((o) => o.textContent);

// Awaited: the form fires /projects, /departments and /users/directory on
// mount, and those resolve after render. Without flushing them here every test
// trails an "update was not wrapped in act(...)" warning, which buries any
// warning that actually matters.
const renderForm = async (props: any = {}) => {
  const r = render(
    <RequestForm availableItems={CAPPED} onSubmit={vi.fn()} isLoading={false} {...props} />,
  );
  await act(async () => { await Promise.resolve(); });
  return r;
};

// Real timers throughout. Fake ones have to be advanced from inside `act`
// while `waitFor` is also polling on them, and the two spin against each other
// until the worker runs out of heap.
const DEBOUNCE_MS = 250;
const settle = () => new Promise((r) => setTimeout(r, DEBOUNCE_MS + 120));

beforeEach(() => {
  optionsGet.mockClear();
  optionsReply = { items: [BEYOND] };
});
afterEach(() => vi.clearAllMocks());

const box = () => screen.getByPlaceholderText('Search all items by name…');

/**
 * Type character by character — one change event each, as a real keyboard
 * produces — then let the 250ms debounce elapse and the reply settle.
 * (@testing-library/user-event is not a dependency of this project; firing the
 * events directly keeps the test from adding one.)
 */
const typeAndSettle = async (text: string) => {
  // Each keystroke gets its OWN act, so the search effect re-runs per
  // character exactly as it does for a real typist. Firing them all inside one
  // act instead lets React batch them into a single state update: the effect
  // then runs once, one request goes out, and the debounce assertion passes
  // whether or not a debounce exists. (Confirmed by deleting the debounce and
  // watching the test stay green.) No awaited delay between them, so the whole
  // burst lands inside the 250ms window.
  for (let i = 1; i <= text.length; i++) {
    await act(async () => { fireEvent.change(box(), { target: { value: text.slice(0, i) } }); });
  }
  await act(async () => { await settle(); });
};

describe('RequestForm item picker — server-side search', () => {
  it('asks the SERVER, passing the typed term', async () => {
    await renderForm();
    await typeAndSettle('zen');
    await waitFor(() => expect(optionsGet).toHaveBeenCalled());
    expect(optionsGet).toHaveBeenCalledWith('/inventory/options', {
      params: { search: 'zen', take: 50 },
    });
  });

  it('does not query below three characters', async () => {
    // A trigram index is built from 3-character grams, so a shorter term
    // cannot use it and falls back to scanning every row — on every keystroke,
    // for every user, to return a flood nobody wants.
    await renderForm();
    await typeAndSettle('zе'.slice(0, 1));      // one character
    expect(optionsGet).not.toHaveBeenCalled();
    await typeAndSettle('ze');                   // two characters
    expect(optionsGet).not.toHaveBeenCalled();
    await typeAndSettle('zen');                  // three — now it asks
    await waitFor(() => expect(optionsGet).toHaveBeenCalled());
  });

  it('says a capped search is capped, instead of looking like the whole answer', async () => {
    // The server matches across the catalogue but returns one page. Silence
    // here would be the same silent-truncation bug in a new place: the item
    // exists, it matched, and it is not on screen.
    optionsReply = {
      items: Array.from({ length: 50 }, (_, i) => ({
        id: `i${i}`, name: `Zener Diode ${i}`, unit: 'pcs', stock: 5, status: 'AVAILABLE',
      })),
      hasMore: true,
    };
    await renderForm();
    await typeAndSettle('zen');
    await waitFor(() => expect(optionsGet).toHaveBeenCalled());
    expect(await screen.findByText(/showing the best 50 matches/i)).toBeTruthy();
  });

  it('debounces a burst of keystrokes into ONE request', async () => {
    await renderForm();
    await typeAndSettle('zener');
    await waitFor(() => expect(optionsGet).toHaveBeenCalled());
    // Five characters, one call — not "z", "ze", "zen", "zene", "zener".
    expect(optionsGet).toHaveBeenCalledTimes(1);
  });

  it('offers an item that was NOT in the list the page supplied', async () => {
    await renderForm();
    expect(options().join()).not.toMatch(/Zener/);
    await typeAndSettle('zen');
    await waitFor(() => expect(options().join()).toMatch(/Zener Diode/));
    // Replaced, not merged: the server's answer IS the answer while searching.
    expect(options().join()).not.toMatch(/Antenna/);
  });

  it('falls back to the supplied list when the box is emptied', async () => {
    await renderForm();
    await typeAndSettle('zen');
    await waitFor(() => expect(options().join()).toMatch(/Zener/));
    await act(async () => { fireEvent.change(box(), { target: { value: '' } }); });
    await act(async () => { await settle(); });
    await waitFor(() => expect(options().join()).toMatch(/Antenna/));
  });

  it('says so when the server matches nothing, instead of looking empty', async () => {
    optionsReply = { items: [] };
    await renderForm();
    await typeAndSettle('nothinglikethis');
    await waitFor(() => expect(options().join()).toMatch(/No item matches that search/));
  });

  it('drops the "list is not complete" notice while a search is running', async () => {
    await renderForm({ optionsTruncated: true, optionsTotal: 5000 });
    expect(screen.getByText(/This list is not complete/)).toBeInTheDocument();
    await typeAndSettle('zen');
    // During a search the server has answered over the whole catalogue, so the
    // warning would be a lie.
    await waitFor(() =>
      expect(screen.queryByText(/This list is not complete/)).not.toBeInTheDocument(),
    );
  });

  it('hides the box for a preselected item, and still offers that item', async () => {
    await renderForm({ item: { ...BEYOND, createdAt: '', updatedAt: '' } });
    expect(screen.queryByPlaceholderText('Search all items by name…')).not.toBeInTheDocument();
    // Folded in although availableItems does not contain it — otherwise the
    // modal names an item it cannot show.
    expect(options().join()).toMatch(/Zener Diode/);
    expect(optionsGet).not.toHaveBeenCalled();
  });
});
