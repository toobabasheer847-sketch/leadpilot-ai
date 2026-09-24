import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/session';

export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <p className="session-check">Checking session</p>;
  if (status !== 'authenticated') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
