import { client } from '@/api/client';
import { ApiResponse, ComponentRequest } from '@/types';

export const requestsApi = {
  getAll: async (params?: Record<string, any>): Promise<ComponentRequest[]> => {
    const response = await client.get<ApiResponse<any>>('/requests', { params });
    const data = response.data.data;
    return Array.isArray(data) ? data : (data?.items || []);
  },
};
