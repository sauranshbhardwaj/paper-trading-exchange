import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { loginSchema } from '@pte/shared';
import { AuthLayout } from '../components/AuthLayout.tsx';
import { TextField } from '../components/TextField.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useAuthForm } from '../hooks/useAuthForm.ts';

export const DEFAULT_ROUTE = '/trade/BTC-USD';

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? DEFAULT_ROUTE;
  const form = useAuthForm(loginSchema, { email: '', password: '' }, async (values) => {
    await login(values);
    navigate(from, { replace: true });
  });

  if (user) return <Navigate to={from} replace />;

  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Log in to keep trading."
      footer={
        <>
          New here? <Link to="/register">Create an account</Link>
        </>
      }
    >
      <form onSubmit={(event) => void form.submit(event)} noValidate>
        <TextField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={form.values.email}
          error={form.errors.fields.email}
          onChange={(value) => form.setField('email', value)}
        />
        <TextField
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={form.values.password}
          error={form.errors.fields.password}
          onChange={(value) => form.setField('password', value)}
        />
        {form.errors.message && (
          <div className="alert alert-danger py-2 small" role="alert">
            {form.errors.message}
          </div>
        )}
        <button type="submit" className="btn btn-accent w-100" disabled={form.submitting}>
          {form.submitting ? 'Logging in…' : 'Log in'}
        </button>
        {import.meta.env.DEV && (
          <p className="form-text mt-3 mb-0">
            Dev demo accounts (after <code>npm run db:seed</code>): alice@example.com or
            bob@example.com, password <code>password123</code>.
          </p>
        )}
      </form>
    </AuthLayout>
  );
}
