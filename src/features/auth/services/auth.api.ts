import { client } from '@/api/client';
import { ApiResponse, LoginResponse } from '@/types';

export const authApi = {
  login: async (email: string, password: string): Promise<LoginResponse> => {
    const response = await client.post<ApiResponse<LoginResponse>>('/auth/login', {
      email,
      password,
    });
    return response.data.data;
  },

  /** Request a password-reset email. Always resolves (server never reveals
   *  whether the email exists) — the caller shows a generic confirmation. */
  forgotPassword: async (email: string): Promise<void> => {
    await client.post('/auth/forgot-password', { email });
  },

  /** Consume the emailed token + set a new password. */
  resetPassword: async (token: string, password: string): Promise<void> => {
    await client.post('/auth/reset-password', { token, password });
  },
};
