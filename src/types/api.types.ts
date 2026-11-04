import { User } from './models.types';

export interface ApiResponse<T> {
  statusCode: number;
  message: string;
  data: T;
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export interface RefreshResponse {
  accessToken: string;
  // Server rotates the refresh token on every successful refresh — each token
  // is single-use. Clients MUST persist this and use it on the next refresh,
  // or they'll get a 401 once the in-storage token gets revoked.
  refreshToken: string;
}
