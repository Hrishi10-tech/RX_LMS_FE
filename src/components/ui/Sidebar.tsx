import { ChevronLeft, ChevronRight, X } from 'lucide-react';

export interface MenuItem {
  name: string;
  path: string;
  icon?: React.ReactNode;
  badge?: number;
}

interface SidebarProps {
  menuItems: MenuItem[];
  activePath: string;
  onNavigate: (path: string) => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
  onMobileClose?: () => void;
}

/**
 * Up to two initials for a collapsed nav tile — "Inventory Items" -> "II",
 * "Dashboard" -> "D". Purely visual: the accessible name and tooltip already
 * carry the full label, so this is aria-hidden at the call site.
 *
 * Only used for a menu item that supplies no `icon`. Every menu in this app
 * now does, so in practice the icon branch always wins; initials were the
 * interim fix before the icons existed.
 */
const initialsFor = (name: string): string =>
  (name || '')
    .split(/[\s/&-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '•';

export const Sidebar = ({ menuItems, activePath, onNavigate, isCollapsed = false, onToggleCollapse, onMobileClose }: SidebarProps) => {
  return (
    // A LIGHT rail. This used to be a near-black panel; the dark navy it was
    // recoloured to (#1a1a2e) is the design language's DARK-MODE card surface,
    // so using it here put a dark-theme colour in the middle of a light theme.
    // White rail + violet gradient on the active item is the light-theme read.
    <div className="flex flex-col w-full h-full bg-card border-r border-line min-h-screen relative">
      {/* Header */}
      <div className="h-14 flex items-center justify-between px-4 border-b border-line">
        {/* `text-brand` now that the ground is white — the primary violet is
            5.7:1 here. (On the old dark rail it managed only ~3:1, which is
            why this used the lighter accent; that accent would fail on white,
            at 2.7:1, so the two swapped when the rail did.) */}
        {!isCollapsed && <h1 className="text-sm tracking-widest text-brand font-bold">LMS PORTAL</h1>}
        {isCollapsed && <div className="w-full flex justify-center text-brand font-bold text-sm">LMS</div>}
        <button onClick={onMobileClose} aria-label="Close menu" className="md:hidden p-1 rounded-lg text-muted hover:text-ink hover:bg-hover transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Navigation */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-3">
        {/* Section eyebrow — the micro-label style from the design language
            (11px, uppercase, 0.6px tracking, muted). Hidden when collapsed,
            where there is no room for it. */}
        {!isCollapsed && (
          <p className="px-4 pb-2 text-[11px] font-semibold uppercase tracking-[0.6px] text-muted">Main</p>
        )}
        <nav className="px-2 space-y-0.5">
          {menuItems.map((item) => {
            const isActive = activePath === item.path || (item.path.split('/').length > 2 && activePath.startsWith(`${item.path}/`));
            // The icon renders in BOTH states now. It used to appear only when
            // collapsed, so the expanded rail was a plain list of words; every
            // menu supplies one (AppRoutes' NAV_ICON table is typed so a
            // missing label is a compile error), which is what makes showing
            // it unconditionally safe.
            const glyph = item.icon ? item.icon : (
              // Fallback for a menu item with no `icon`. Unreachable from
              // inside this app — kept because Sidebar is a shared component
              // and a blank 14x14 square, which is what this used to render,
              // made every tile identical.
              <span
                aria-hidden="true"
                className="flex h-4 w-4 items-center justify-center rounded bg-brand-100 text-[9px] font-bold leading-none tracking-tight text-brand-700"
              >
                {initialsFor(item.name)}
              </span>
            );
            return (
              <button
                key={item.path}
                onClick={() => onNavigate(item.path)}
                aria-label={item.name}
                aria-current={isActive ? 'page' : undefined}
                className={`group flex items-center justify-between w-full rounded-xl text-[13px] font-semibold transition-all duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] ${
                  isActive
                    ? 'bg-brand text-white'
                    : 'text-muted hover:bg-brand-50 hover:text-brand'
                } ${isCollapsed ? 'px-2 py-2.5 relative' : 'px-3 py-2'}`}
                title={isCollapsed ? item.name : undefined}
              >
                <div className={`flex items-center gap-2.5 min-w-0 ${isCollapsed ? 'justify-center w-full gap-0' : ''}`}>
                  <span className="shrink-0 flex items-center justify-center">{glyph}</span>
                  {!isCollapsed && <span className="truncate">{item.name}</span>}
                </div>
                {item.badge !== undefined && item.badge > 0 && (
                  !isCollapsed ? (
                    <span className="flex h-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-[10px] font-bold text-white shadow-sm">
                      {item.badge}
                    </span>
                  ) : (
                    <span className="absolute top-1 right-1 flex h-3 w-3 items-center justify-center rounded-full bg-red-600 text-[8px] font-bold text-white border border-card">
                      {item.badge > 9 ? '9+' : item.badge}
                    </span>
                  )
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Collapse Toggle */}
      {onToggleCollapse && (
        <div className="border-t border-line p-2 hidden md:block">
          <button
            onClick={onToggleCollapse}
            aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="w-full flex items-center justify-center p-2 rounded-xl hover:bg-brand-50 text-faint hover:text-brand transition-colors"
          >
            {isCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>
      )}
    </div>
  );
};
