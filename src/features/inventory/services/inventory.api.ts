import { client } from '@/api/client';
import { ApiResponse, InventoryItem } from '@/types';

export const inventoryApi = {
  getAll: async (params?: Record<string, any>): Promise<InventoryItem[]> => {
    const response = await client.get<ApiResponse<any>>('/inventory', { params });
    const data = response.data.data;
    // Handle both paginated { items, total } and direct array responses
    return Array.isArray(data) ? data : (data?.items || []);
  },
};
