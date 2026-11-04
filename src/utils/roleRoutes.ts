import { UserRole } from '@/types';

/**
 * Canonical landing path for each role.
 *
 * Why this exists: LoginPage routed by role from a locally-declared map, while
 * RoleRoute's "Back to dashboard" link hard-coded `/`. The root path renders
 * nothing useful for most roles, so a wrong-role user clicking "Back to
 * dashboard" effectively bounced to login. Both now import this single map so
 * the post-login destination and the permission-denied escape hatch stay in
 * sync.
 */
export const rolePathMap: Record<UserRole, string> = {
  [UserRole.SUPER_ADMIN]: '/super-admin',
  [UserRole.ADMIN]: '/admin',
  [UserRole.MANAGER]: '/manager',
  [UserRole.USER]: '/user',
  [UserRole.LAB]: '/lab',
  [UserRole.PROCUREMENT]: '/procurement',
  [UserRole.INVENTORY]: '/inventory',
  [UserRole.FINANCE]: '/finance',
  [UserRole.ASSOCIATE_FINANCE]: '/associate-finance',
};

/** Role-aware home path, falling back to `/` for an unknown/missing role. */
export const roleHomePath = (role?: UserRole | string | null): string =>
  (role && rolePathMap[role as UserRole]) || '/';
