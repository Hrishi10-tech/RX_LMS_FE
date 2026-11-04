import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '@/hooks';
import { roleHomePath } from '@/utils/roleRoutes';
import { buildClickTargetUrl } from '../utils/clickTarget';

/**
 * Where a desktop alert's click lands: `/open-notification?type=…&id=…&nt=…`.
 *
 * The server cannot build the final link — the same indent opens a different
 * page for a requester, an admin, Procurement or Finance — so the alert
 * carries what it is about, and this page sends the signed-in person to the
 * right place with the same mapping the Notifications page uses. If the
 * browser was closed, the sign-in page brings them back here afterwards.
 */
export const OpenNotificationPage = () => {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const role = user?.role ?? '';
  const roleSlug = role.toLowerCase().replace(/_/g, '-') || 'user';
  const target = buildClickTargetUrl(
    { relatedEntityType: params.get('type'), relatedEntityId: params.get('id'), type: params.get('nt') },
    role,
    roleSlug,
  );
  return <Navigate to={target ?? `${roleHomePath(role)}/notifications`} replace />;
};
