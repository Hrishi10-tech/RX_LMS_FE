/**
 * Finance, Associate Finance, Procurement and Inventory work for every
 * department, so their user records carry none. Each still has a home
 * department for its OWN needs (Anushiya's pens → Finance) — marked on the
 * department by `roleHome`, mirroring the backend's ROLE_HOME.
 */
const HOME_KEY_BY_ROLE: Record<string, string> = {
  FINANCE: 'FINANCE',
  ASSOCIATE_FINANCE: 'FINANCE',
  PROCUREMENT: 'PROCUREMENT',
  INVENTORY: 'INVENTORY',
};

/** The home department id for an org-wide role, or '' when the role has none (or it is not loaded yet). */
export const homeDepartmentId = (role: string | undefined, departments: Array<{ id: string; roleHome?: string | null }>): string => {
  const key = role ? HOME_KEY_BY_ROLE[role] : undefined;
  return (key && departments.find((d) => d.roleHome === key)?.id) || '';
};
