import { client } from '@/api/client';
import { ApiResponse, Department } from '@/types';

export const departmentsApi = {
  getAll: async (): Promise<Department[]> => {
    const response = await client.get<ApiResponse<Department[]>>('/departments');
    return response.data.data;
  },
  create: async (data: { name: string; parentId?: string; indentApprovalMode?: string }): Promise<Department> => {
    const response = await client.post<ApiResponse<Department>>('/departments', data);
    return response.data.data;
  },
  update: async (id: string, data: { name?: string; parentId?: string | null; indentApprovalMode?: string }): Promise<Department> => {
    const response = await client.patch<ApiResponse<Department>>(`/departments/${id}`, data);
    return response.data.data;
  },
  delete: async (id: string): Promise<void> => {
    await client.delete(`/departments/${id}`);
  },
};
