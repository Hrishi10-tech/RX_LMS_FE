import { UserRole } from '@/types';
import { palette } from '@/lib/palette';

/**
 * Per-role browser tab identity: favicon + document title.
 *
 * Everyone here keeps half a dozen logins open at once, and every tab read
 * "Lab Management System" behind the same flask icon — impossible to tell
 * apart. Each role now gets its own mark and its own title.
 *
 * The marks deliberately reuse public/icon.svg's language: the same dark
 * rounded square, the same brand violet, one bold glyph. Anything finer than
 * "two or three primitives" turns to mush at the 16px a tab actually
 * renders, so each is built from circles, rects and straight strokes only —
 * no text elements, whose font resolution inside a favicon is unreliable.
 */

const BG = palette.mark;
const FG = palette.brand;

// The app's own flask — the identity mark. Used for LAB (where it's most apt)
// and as the fallback before anyone signs in.
const FLASK = `
  <path d="M196 108h120v14l-8 6v62l84 148a56 56 0 0 1-48 84H172a56 56 0 0 1-48-84l84-148v-62l-8-6z"
        fill="none" stroke="${FG}" stroke-width="22" stroke-linejoin="round"/>
  <path d="M162 300h188l30 52a34 34 0 0 1-29 52H161a34 34 0 0 1-29-52z" fill="${FG}"/>`;

// One person: head + shoulders.
const PERSON = `
  <circle cx="256" cy="196" r="62" fill="${FG}"/>
  <path d="M136 396a120 120 0 0 1 240 0z" fill="${FG}"/>`;

// Two people — "manages other people". The second is dimmed so the pair
// still reads as one silhouette plus one behind it rather than a blob.
const PEOPLE = `
  <circle cx="196" cy="198" r="56" fill="${FG}"/>
  <path d="M96 388a100 100 0 0 1 200 0z" fill="${FG}"/>
  <circle cx="338" cy="214" r="44" fill="${FG}" opacity=".55"/>
  <path d="M262 382a76 76 0 0 1 152 0z" fill="${FG}" opacity=".55"/>`;

// Shield — delegated authority over departments.
const SHIELD = `
  <path d="M256 92l132 50v106c0 92-64 146-132 174-68-28-132-82-132-174V142z"
        fill="none" stroke="${FG}" stroke-width="30" stroke-linejoin="round"/>`;

// Globe — oversight of the whole organisation.
const GLOBE = `
  <circle cx="256" cy="256" r="140" fill="none" stroke="${FG}" stroke-width="28"/>
  <ellipse cx="256" cy="256" rx="62" ry="140" fill="none" stroke="${FG}" stroke-width="28"/>
  <path d="M116 256h280" stroke="${FG}" stroke-width="28" stroke-linecap="round"/>`;

// Shopping bag — buying things. Straight sides, not tapered: a taper plus a
// closed top edge reads as a rubbish bin, which is a poor mark for the team
// that orders things. The handle arcs well clear of the mouth so it reads as
// a handle rather than a lid.
const BAG = `
  <path d="M150 200h212v186a26 26 0 0 1-26 26H176a26 26 0 0 1-26-26z"
        fill="none" stroke="${FG}" stroke-width="28" stroke-linejoin="round"/>
  <path d="M204 200v-14a52 52 0 0 1 104 0v14" fill="none" stroke="${FG}" stroke-width="28"/>`;

// Carton — holding stock. Nearly square on purpose: the earlier wide, short
// version with a seam near the top read as a wallet or a bank card.
const BOX = `
  <rect x="132" y="168" width="248" height="240" rx="16" fill="none" stroke="${FG}" stroke-width="28"/>
  <path d="M132 244h248" stroke="${FG}" stroke-width="28"/>
  <path d="M256 168v76" stroke="${FG}" stroke-width="28"/>`;

// Coin stack — money. Three coins for Finance.
const COINS = `
  <ellipse cx="256" cy="330" rx="118" ry="44" fill="${FG}"/>
  <ellipse cx="256" cy="256" rx="118" ry="44" fill="${FG}" opacity=".85"/>
  <ellipse cx="256" cy="182" rx="118" ry="44" fill="${FG}" opacity=".7"/>`;

// Two coins against Finance's three — same family (they are the same surface,
// one without authority), just a shorter stack. An earlier version outlined the
// top coin, which read as a camera lens rather than money.
const COINS_LIGHT = `
  <ellipse cx="256" cy="318" rx="118" ry="44" fill="${FG}"/>
  <ellipse cx="256" cy="238" rx="118" ry="44" fill="${FG}" opacity=".8"/>`;

interface Mark { glyph: string; title: string }

const MARKS: Record<string, Mark> = {
  [UserRole.SUPER_ADMIN]:       { glyph: GLOBE,       title: 'Super Admin' },
  [UserRole.ADMIN]:             { glyph: SHIELD,      title: 'Admin' },
  [UserRole.MANAGER]:           { glyph: PEOPLE,      title: 'Manager' },
  [UserRole.USER]:              { glyph: PERSON,      title: 'My Requests' },
  [UserRole.LAB]:               { glyph: FLASK,       title: 'Lab' },
  [UserRole.PROCUREMENT]:       { glyph: BAG,         title: 'Procurement' },
  [UserRole.INVENTORY]:         { glyph: BOX,         title: 'Inventory' },
  [UserRole.FINANCE]:           { glyph: COINS,       title: 'Finance' },
  [UserRole.ASSOCIATE_FINANCE]: { glyph: COINS_LIGHT, title: 'Assoc. Finance' },
};

const FALLBACK: Mark = { glyph: FLASK, title: 'Lab Management System' };

/** Full SVG document for a role's mark. Exported so a preview can render it. */
export const markSvg = (role?: string | null): string => {
  const { glyph } = (role && MARKS[role]) || FALLBACK;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img">`
    + `<rect width="512" height="512" rx="96" fill="${BG}"/>${glyph}</svg>`;
};

export const markTitle = (role?: string | null): string => {
  const m = (role && MARKS[role]) || FALLBACK;
  return m === FALLBACK ? m.title : `${m.title} · LMS`;
};

/**
 * Point the tab's icon and title at this role. Safe to call repeatedly.
 *
 * The SVG is inlined as a data URI rather than shipped as nine files: it is
 * a few hundred bytes, needs no extra request, and keeps the glyph next to
 * the role it belongs to. `encodeURIComponent` (not base64) so the markup
 * stays readable in devtools.
 */
export function applyRoleFavicon(role?: string | null): void {
  try {
    const href = `data:image/svg+xml,${encodeURIComponent(markSvg(role))}`;
    // Reuse the existing <link rel="icon"> from index.html; create one only
    // if a future index.html drops it.
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = 'image/svg+xml';
    link.href = href;
    document.title = markTitle(role);
  } catch {
    // A tab icon is decoration. If anything here throws (exotic browser,
    // locked-down DOM) the app must carry on untouched.
  }
}
