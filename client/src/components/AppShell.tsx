import { Navigate, Route, Routes } from 'react-router';
import { useAuth } from '../context/AuthContext.tsx';
import { DEFAULT_ROUTE, LoginPage } from '../pages/LoginPage.tsx';
import { NotFoundPage } from '../pages/NotFoundPage.tsx';
import { RegisterPage } from '../pages/RegisterPage.tsx';
import { TradePage } from '../pages/TradePage.tsx';
import { NavBar } from './NavBar.tsx';
import { Toasts } from './Toasts.tsx';

export function AppShell() {
  const { loading } = useAuth();
  return (
    <div className="app-shell">
      <NavBar />
      {loading ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <Routes>
          <Route path="/" element={<Navigate to={DEFAULT_ROUTE} replace />} />
          <Route path="/trade/:market" element={<TradePage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      )}
      <Toasts />
    </div>
  );
}
