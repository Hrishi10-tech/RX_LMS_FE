import { useEffect, useMemo, useRef, useState } from 'react';
import { client } from '@/api';
import { SearchInput } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { extractErrorMessage } from '@/lib';
import { fmtDateTime } from '@/utils/date';
import { Plus, Trash2, Pin, PinOff, Loader2, NotebookPen, Search } from 'lucide-react';
import { useAbortOnUnmount } from '@/hooks';

/**
 * A notepad.
 *
 * Procurement keeps working notes — what a vendor said on the phone, a part
 * number to chase, what to ask next time — and they were living in a text file
 * on one laptop. Two panes because that is what a notepad is: the list of what
 * you have written on the left, the thing you are writing on the right.
 *
 * Private to the signed-in user. The API scopes every query to the caller, so
 * nobody reads anybody else's.
 */

interface Note {
  id: string;
  title: string | null;
  body: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a row shows, the way a notes app does it.
 *
 * A note's title is optional, so a new one used to render three lines of
 * nothing — "Untitled", "Empty note", and a timestamp — which said less than a
 * blank row would have. Instead the first line of the body becomes the title
 * when no explicit one is set, and the preview is whatever comes after it.
 * Neither is invented: if there is no text there is no line.
 */
const lines = (n: Note) => (n.body || '').split('\n').map(l => l.trim()).filter(Boolean);

const rowTitle = (n: Note) => {


  // Body first. There is no title field any more, so what the row shows must
  // be what the editor shows; `title` survives only for notes written before
  // the field was removed, and only while their body is empty.
  const first = lines(n)[0];
  if (first) return first.slice(0, 60);
  return (n.title || '').trim().slice(0, 60);
};

/** The body text NOT already being used as the title. */
const rowPreview = (n: Note) => lines(n).slice(1).join(' ').slice(0, 70);

export const NotesPage = () => {
    // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
    const abortSignal = useAbortOnUnmount();

  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  // True while moving to another note (opening one, or creating one). The
  // editor still shows the OLD note until the switch lands, so typing in that
  // gap went into the old note and was then wiped from the screen — or saved
  // over it. Typing is held until the new note is actually open.
  const [switching, setSwitching] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const { addToast } = useToast();
  const confirm = useConfirm();
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const selected = notes.find(n => n.id === selectedId) || null;
  const dirty = !!selected && body !== selected.body;

  // Autosave. A scratchpad that can lose what you typed because you navigated
  // away is not a scratchpad. The debounce is long enough that ordinary typing
  // makes one request per pause rather than one per keystroke.
  const SAVE_DEBOUNCE_MS = 700;
  const pending = useRef<{ id: string; body: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = async () => {
    const job = pending.current;
    if (!job) return;
    pending.current = null;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setSaving(true);
    try {
      const res = await client.patch(`/notes/${job.id}`, { body: job.body });
      const n: Note = res.data?.data ?? res.data;
      setNotes(prev => prev.map(x => (x.id === n.id ? n : x)));
      setSavedAt(n.updatedAt);
    } catch (e: any) {
      // Autosave failing silently would be the worst of both worlds: no button
      // to retry with, and no sign anything went wrong.
      addToast(extractErrorMessage(e, 'Could not save — your text is still here, try again'), 'error');
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!selected || body === selected.body) return;
    pending.current = { id: selected.id, body };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    return () => { if (timer.current) clearTimeout(timer.current); };
    /* eslint-disable-next-line */
  }, [body, selectedId]);

  // Leaving the page while a debounce is still pending would drop that last
  // edit, so flush it on unmount.
  useEffect(() => () => { void flush(); }, []); // flush once, on unmount

  const load = async (keepId?: string) => {
    setLoading(true);
    try {
      const res = await client.get('/notes', { signal: abortSignal() });
      const items: Note[] = (res.data?.data ?? res.data)?.items ?? [];
      setNotes(items);
      const keep = keepId ?? selectedId;
      const next = items.find(n => n.id === keep) ?? items[0] ?? null;
      setSelectedId(next?.id ?? null);
      setBody(next?.body ?? '');
      setSavedAt(next?.updatedAt ?? null);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not load your notes'), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // load once, on mount

  // Autosave closes the usual gap, but a reload inside the debounce window
  // would still lose the last few keystrokes.
  useEffect(() => {
    if (!dirty && !saving) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty, saving]);

  // Closing clears the query. A hidden search box still holding text would
  // leave the list filtered with nothing on screen explaining why — the note
  // you were looking for would simply appear to be gone.
  const closeSearch = () => { setSearch(''); setSearchOpen(false); };

  const pick = async (n: Note) => {
    if (n.id === selectedId || switching) return;
    // No "discard your changes?" prompt any more — there is nothing to
    // discard. Write out whatever is still pending, then switch.
    setSwitching(true);
    try {
      await flush();
      setSelectedId(n.id);
      setBody(n.body);
      setSavedAt(n.updatedAt);
    } finally {
      setSwitching(false);
    }
  };

  const create = async () => {
    if (switching) return;
    setSwitching(true);
    let opened = false;
    try {
      // Save the note being left FIRST. Without this, the last edit inside the
      // autosave pause was dropped: switching notes cancelled its timer and
      // the next note's first keystroke replaced it in the queue.
      await flush();
      const res = await client.post('/notes', { title: null, body: '' });
      const n: Note = res.data?.data ?? res.data;
      setNotes(prev => [n, ...prev]);
      setSelectedId(n.id);
      setBody('');
      setSavedAt(n.updatedAt);
      opened = true;
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not create a note'), 'error');
    } finally {
      setSwitching(false);
    }
    // Straight into typing — a new note that needs a second click to start
    // writing in is a worse notepad than a text file.
    if (opened) setTimeout(() => bodyRef.current?.focus(), 50);
  };

  const togglePin = async (n: Note) => {
    try {
      const res = await client.patch(`/notes/${n.id}`, { pinned: !n.pinned });
      const updated: Note = res.data?.data ?? res.data;
      // Re-sorted by the same rule the server uses, so a pin moves the row
      // where the next reload will put it anyway.
      setNotes(prev => [...prev.map(x => (x.id === updated.id ? updated : x))].sort(
        (a, b) => Number(b.pinned) - Number(a.pinned) || +new Date(b.updatedAt) - +new Date(a.updatedAt),
      ));
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not pin that note'), 'error');
    }
  };

  const remove = async (n: Note) => {
    // An empty note has nothing to quote back, and `"" will be removed` reads
    // like a bug. Name it only when it has a name.
    const label = rowTitle(n);
    const ok = await confirm({
      title: 'Delete this note?',
      message: label
        ? `"${label}" will be removed. This cannot be undone.`
        : 'This empty note will be removed. This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await client.delete(`/notes/${n.id}`);
      const rest = notes.filter(x => x.id !== n.id);
      setNotes(rest);
      const next = rest[0] ?? null;
      setSelectedId(next?.id ?? null);
      setBody(next?.body ?? '');
      setSavedAt(next?.updatedAt ?? null);
      addToast('Note deleted', 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not delete that note'), 'error');
    }
  };

  // Filtered in the browser: the whole list is already here (capped at 500 by
  // the API) and typing should narrow instantly rather than per keystroke over
  // the network.
  const visible = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return notes;
    return notes.filter(n => (n.title || '').toLowerCase().includes(s) || n.body.toLowerCase().includes(s));
  }, [notes, search]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Kept even though saving is automatic: people who have typed something
    // they care about press Cmd+S, and it should mean "write it now" rather
    // than hand them the browser's Save Page dialog.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void flush(); }
  };

  return (
    <div className="space-y-4" onKeyDown={onKeyDown}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-ink">Notes</h2>
          <p className="text-sm text-muted mt-0.5">
            Your own scratchpad — {notes.length} note{notes.length === 1 ? '' : 's'}. Only you can see these.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Search lives here rather than permanently above the list: the row
              it used to occupy cost ~60px of a panel capped at 70vh, which is
              a note or two fewer on screen for something most visits do not
              use. Hidden until asked for, and only offered once there is
              enough to be worth searching. */}
          {notes.length > 1 && (
            <button
              onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
              aria-label={searchOpen ? 'Close search' : 'Search your notes'}
              aria-expanded={searchOpen}
              title={searchOpen ? 'Close search' : 'Search your notes'}
              className={`p-2 rounded-md transition-colors ${searchOpen ? 'bg-brand/10 text-brand' : 'text-muted hover:text-brand hover:bg-hover'}`}
            >
              <Search size={16} />
            </button>
          )}
          <button
            onClick={create}
            disabled={switching}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-brand rounded-md hover:bg-brand-dark transition-colors disabled:opacity-60"
          >
            <Plus size={15} /> New note
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4">
        {notes.length === 0 && !loading ? (
          /* With no notes there is nothing to list and nothing to pick, so the
             two panels became two stacked empty boxes saying the same thing —
             and the second one ("pick a note on the left") pointed at an empty
             list. One panel, spanning both columns, until the first note. */
          <button
            type="button"
            onClick={create}
            className="lg:col-span-2 bg-card rounded-xl border border-line-soft shadow-sm p-12 text-center group cursor-pointer hover:bg-brand/5 transition-colors"
          >
            <NotebookPen size={26} className="mx-auto text-faint group-hover:text-brand transition-colors mb-3" />
            <p className="text-sm font-bold text-ink">No notes yet</p>
            <p className="text-xs text-muted group-hover:text-brand transition-colors mt-1">
              Click anywhere here to start your first one.
            </p>
          </button>
        ) : (
        <>
        {/* List */}
        <div className="bg-card rounded-xl border border-line-soft shadow-sm overflow-hidden flex flex-col max-h-[70vh]">
          {searchOpen && (
            <div className="p-3 border-b border-line-soft">
              <SearchInput
                autoFocus
                value={search}
                onChange={e => setSearch(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') closeSearch(); }}
                placeholder="Search your notes..."
              />
            </div>
          )}
          <div className="overflow-y-auto flex-1">
            {loading ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted">
                <Loader2 size={15} className="animate-spin" /> Loading…
              </div>
            ) : visible.length === 0 ? (
              /* Zero notes is handled by the single panel above, so reaching
                 here means the search matched nothing. Left inert on purpose:
                 creating a note because a search failed would be a surprising
                 thing for a click to do. */
              <div className="p-6 text-center">
                <NotebookPen size={22} className="mx-auto text-faint mb-2" />
                <p className="text-xs text-muted">Nothing matches that search.</p>
              </div>
            ) : (
              visible.map(n => (
                <button
                  key={n.id}
                  onClick={() => pick(n)}
                  className={`w-full text-left px-3 py-2.5 border-b border-line-soft last:border-0 transition-colors ${
                    n.id === selectedId ? 'bg-brand/10' : 'hover:bg-hover'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {n.pinned && <Pin size={11} className="text-brand-dark shrink-0" />}
                    <span className="text-xs font-bold text-ink truncate">
                      {rowTitle(n) || <span className="text-muted font-medium">New note</span>}
                    </span>
                  </div>
                  {/* Date and preview share a line: a note with no body should
                      cost one row of height, not three. */}
                  <p className="text-[10px] text-faint truncate mt-0.5">
                    {fmtDateTime(n.updatedAt)}
                    {rowPreview(n) && <span className="text-muted"> · {rowPreview(n)}</span>}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Editor */}
        <div className="bg-card rounded-xl border border-line-soft shadow-sm overflow-hidden flex flex-col max-h-[70vh]">
          {!selected ? (
            <div className="flex-1 flex items-center justify-center p-10 text-center">
              <p className="text-sm text-muted">
                {loading ? 'Loading…' : 'Pick a note on the left, or start a new one.'}
              </p>
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-line-soft flex items-center gap-2">
                {/* The first line of the note IS the title, so a separate
                    field was a second place to put the same thing — and a
                    note titled one thing but starting with another reads as a
                    bug. What the list shows is now exactly what you typed. */}
                <span className="flex-1 text-sm font-bold text-ink truncate">
                  {rowTitle(selected) || <span className="text-muted font-medium">New note</span>}
                </span>
                <button
                  onClick={() => togglePin(selected)}
                  className="p-1.5 text-muted hover:text-brand-dark rounded hover:bg-hover"
                  title={selected.pinned ? 'Unpin' : 'Pin to the top'}
                >
                  {selected.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                </button>
                <button
                  onClick={() => remove(selected)}
                  className="p-1.5 text-muted hover:text-red-700 rounded hover:bg-hover"
                  title="Delete this note"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <textarea
                ref={bodyRef}
                value={body}
                onChange={e => setBody(e.target.value)}
                readOnly={switching}
                aria-busy={switching}
                placeholder="Start typing…"
                className="flex-1 w-full px-4 py-3 text-sm text-ink outline-none resize-none font-mono leading-relaxed placeholder:font-sans placeholder:text-faint"
              />

              {/* Status, not a control. There is nothing left to press. */}
              <div className="px-4 py-2.5 border-t border-line-soft flex items-center gap-2">
                <span className="text-[11px] text-faint inline-flex items-center gap-1.5">
                  {saving ? (
                    <><Loader2 size={11} className="animate-spin" /> Saving…</>
                  ) : dirty ? (
                    'Editing…'
                  ) : (
                    <>Saved · {fmtDateTime(savedAt ?? selected.updatedAt)}</>
                  )}
                </span>
              </div>
            </>
          )}
        </div>
        </>
        )}
      </div>
    </div>
  );
};
