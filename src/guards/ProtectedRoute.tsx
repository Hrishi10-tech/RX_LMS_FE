import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../hooks';
import { BrandLoader } from '../components/ui';

export const ProtectedRoute = () => {
  const { isAuthenticated, isLoading } = useAuth();
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

  if (!isAuthenticated) {
    // Carry where they were going, so a link opened while signed out (a
    // desktop alert clicked with the browser closed, a shared link) lands
    // there after sign-in instead of on the dashboard.
    const next = location.pathname + location.search;
    return <Navigate to={next && next !== '/' ? `/login?next=${encodeURIComponent(next)}` : '/login'} replace />;
  }

  return (
    <>
      <Outlet />
    </>
  );
};
