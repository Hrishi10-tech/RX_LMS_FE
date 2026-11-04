import { client } from '@/api/client';
import { ApiResponse, User } from '@/types';

export const usersApi = {
  getAll: async (): Promise<User[]> => {
    const response = await client.get<ApiResponse<User[]>>('/users');
    return response.data.data;
  },
  create: async (data: Partial<User> & { password?: string, adminDepartmentIds?: string[], managerId?: string }): Promise<User> => {
    const response = await client.post<ApiResponse<User>>('/users', data);
    return response.data.data;
  },
  /**
   * Reveal one user's stored password (Super Admin only).
   *
   * Fetched per row, on click — never as part of the users list, so readable
   * passwords don't ride along in every page/search/tab request. The server
   * writes an audit entry for each call.
   *
   * Resolves to `{ available: false, reason }` rather than rejecting when there
   * is nothing to show (user set their own password, or it predates the
   * feature), so the caller renders an explanation instead of an error toast.
   */
  getPassword: async (
    id: string,
  ): Promise<{ available: true; password: string } | { available: false; reason: string }> => {
    const response = await client.get<ApiResponse<any>>(`/users/${id}/password`);
    return response.data.data;
  },
  /** The Associate Finance roster, for the page Finance manages them from. */
  listAssociateFinance: async (): Promise<any[]> => {
    const response = await client.get<ApiResponse<any[]>>('/users/associate-finance');
    return response.data.data;
  },
  /**
   * Edit one Associate Finance account — rename, change the login email, issue
   * a new password, retire or restore it. Anything not in this shape is a 400:
   * the endpoint's DTO is deliberately narrow so this page can never reach the
   * role/department machinery.
   */
  updateAssociateFinance: async (
    id: string,
    data: { name?: string; email?: string; password?: string; isActive?: boolean },
  ): Promise<User & { releasedPayments: number }> => {
    const response = await client.patch<ApiResponse<any>>(`/users/associate-finance/${id}`, data);
    return response.data.data;
  },
  update: async (id: string, data: Partial<User> & { adminDepartmentIds?: string[], managerId?: string }): Promise<User> => {
    const response = await client.patch<ApiResponse<User>>(`/users/${id}`, data);
    return response.data.data;
  },
  // FINANCE is a target too: Finance promotes its own Associate Finance users
  // from the Associate Finance page. The server enforces the ladder (only an
  // ASSOCIATE_FINANCE can become FINANCE) and who may do it.
  promote: async (id: string, role: 'MANAGER' | 'ADMIN' | 'FINANCE'): Promise<User> => {
    const response = await client.post<ApiResponse<User>>(`/users/${id}/promote`, { role });
    return response.data.data;
  },
  // Demote one rung down. For MANAGER→USER, pass `reassignToManagerId` to move
  // the demoted manager's reports to a replacement (omit/null = leave them
  // unassigned). The response carries reportsReassigned / reportsUnassigned so
  // the caller can tell the user exactly what happened to the team.
  demote: async (
    id: string,
    role: 'MANAGER' | 'USER' | 'ASSOCIATE_FINANCE',
    reassignToManagerId?: string | null,
  ): Promise<User & { reportsReassigned?: number; reportsUnassigned?: number }> => {
    const response = await client.post<ApiResponse<User & { reportsReassigned?: number; reportsUnassigned?: number }>>(
      `/users/${id}/demote`,
      reassignToManagerId ? { role, reassignToManagerId } : { role },
    );
    return response.data.data;
  },
  // Reversible lifecycle: deactivate retires the account (isActive=false,
  // deactivatedAt=now) while keeping the row + history; reactivate restores it.
  // SUPER_ADMIN-only server-side. No body — the id in the path is enough.
  deactivate: async (id: string): Promise<User> => {
    const response = await client.post<ApiResponse<User>>(`/users/${id}/deactivate`);
    return response.data.data;
  },
  reactivate: async (id: string): Promise<User> => {
    const response = await client.post<ApiResponse<User>>(`/users/${id}/reactivate`);
    return response.data.data;
  },
};
