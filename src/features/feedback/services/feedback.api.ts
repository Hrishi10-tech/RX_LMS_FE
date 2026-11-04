import { client } from '@/api';

/**
 * Feedback API — submission is open to every authenticated role; inbox
 * + status / delete endpoints are SUPER_ADMIN gated by the backend.
 */
export const feedbackApi = {
  /**
   * Submit feedback. `attachment` is optional (image or video, ≤25 MB).
   */
  submit: async (message: string, attachment?: File) => {
    const fd = new FormData();
    fd.append('message', message);
    if (attachment) fd.append('attachment', attachment);
    const r = await client.post('/feedback', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return r.data?.data ?? r.data;
  },

  /**
   * Super-admin inbox. Optional status filter (NEW / SEEN / RESOLVED).
   */
  list: async (status?: 'NEW' | 'SEEN' | 'RESOLVED') => {
    const r = await client.get('/feedback', { params: status ? { status } : {} });
    return r.data?.data ?? r.data;
  },

  updateStatus: async (id: string, status: 'NEW' | 'SEEN' | 'RESOLVED') => {
    const r = await client.patch(`/feedback/${id}/status`, { status });
    return r.data?.data ?? r.data;
  },

  remove: async (id: string) => {
    const r = await client.delete(`/feedback/${id}`);
    return r.data?.data ?? r.data;
  },

  /**
   * Fetches the attachment as a blob via the authenticated axios client
   * and returns a blob URL the caller can drop into an <img> or <video>
   * `src`. A plain `<img src="/feedback/.../attachment">` would 401 because
   * the browser doesn't attach the Authorization header on raw asset
   * requests — same problem ViewReceiptLink already solves for indents.
   *
   * Caller should `URL.revokeObjectURL(url)` on unmount to avoid leaking
   * the blob.
   */
  fetchAttachmentBlob: async (id: string): Promise<string> => {
    const res = await client.get(`/feedback/${id}/attachment`, { responseType: 'blob' });
    return URL.createObjectURL(res.data);
  },
};
