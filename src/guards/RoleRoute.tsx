import { Navigate, Outlet, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../hooks';
import { UserRole } from '../types';
import { roleHomePath } from '../utils/roleRoutes';
import { BrandLoader } from '../components/ui';

interface RoleRouteProps {
  allowedRoles: UserRole[];
}

export const RoleRoute = ({ allowedRoles }: RoleRouteProps) => {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    // The very first thing anyone sees on a cold start — it used to be the
    // bare string "Loading...". This is the brand loader instead.
    return (
      <div className="min-h-screen flex items-center justify-center bg-page">
        <BrandLoader variant="page" message="Preparing your workspace…" />
      </div>
    );
  }

  // Unauthenticated → log in.
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  // Authenticated but wrong role → show a permission-denied screen so the user
  // knows what happened. Previously this redirected to /login, which made it
  // look like their session had expired even when they were perfectly logged in.
  if (!allowedRoles.includes(user.role)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface px-6">
        <div className="max-w-md text-center">
          <div className="text-6xl mb-4">🔒</div>
          <h1 className="text-2xl font-semibold text-ink mb-2">Permission denied</h1>
          <p className="text-secondary mb-6">
            Your role ({user.role.replace('_', ' ').toLowerCase()}) doesn't have access to this page.
            Ask an administrator if you think this is a mistake.
          </p>
          <Link
            to={roleHomePath(user.role)}
            className="inline-block px-4 py-2 bg-brand text-white rounded-full hover:bg-brand-dark transition-colors"
          >
            Back to dashboard
          </Link>
        </div>
      </div>
    );
  }

  return <Outlet />;
};
