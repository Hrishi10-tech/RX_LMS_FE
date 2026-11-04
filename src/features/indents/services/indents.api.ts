import { client } from '@/api/client';
import { ApiResponse, Indent } from '@/types';

// Indent approval is split between two endpoints on the backend
// (/:id/tech-approve and /:id/ceo-approve) — there's no single /approve route.
// If/when a unified approval endpoint exists, add it here.
export const indentsApi = {
  getAll: async (params?: Record<string, any>): Promise<Indent[]> => {
    const response = await client.get<ApiResponse<any>>('/indents', { params });
    const data = response.data.data;
    return Array.isArray(data) ? data : (data?.items || []);
  },

  /**
   * Per-line review of a spawned indent's items in its initial approval
   * window — the indent analogue of bomListsApi.reviewItems, fired from the
   * BOM approval slip. Ticks a subset of the indent's items and APPROVEs or
   * REJECTs just those; `reason` is required when decision is REJECT. The
   * indent stays PENDING (verdicts are reversible) — the REJECTED lines are
   * only dropped at the whole-indent "approve & advance". Returns the fresh
   * indent (the slip re-pulls the BOM after, so the value is advisory).
   */
  reviewLines: (id: string, payload: {
    itemIds: string[];
    decision: 'APPROVE' | 'REJECT';
    reason?: string;
  }) => client.post(`/indents/${id}/items/review`, payload).then(r => r.data?.data ?? r.data),
};
