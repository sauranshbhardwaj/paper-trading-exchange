import { Link, Navigate, useNavigate } from 'react-router';
import { registerSchema } from '@pte/shared';
import { AuthLayout } from '../components/AuthLayout.tsx';
import { TextField } from '../components/TextField.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { useAuthForm } from '../hooks/useAuthForm.ts';
import { DEFAULT_ROUTE } from './LoginPage.tsx';

export function RegisterPage() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const form = useAuthForm(
    registerSchema,
    { email: '', displayName: '', password: '' },
    async (values) => {
      await register(values);
      navigate(DEFAULT_ROUTE, { replace: true });
    },
  );

  if (user) return <Navigate to={DEFAULT_ROUTE} replace />;

  return (
    <AuthLayout
      title="Create your account"
      subtitle="You'll start with $100,000 in play money."
      footer={
        <>
          Already trading? <Link to="/login">Log in</Link>
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
          id="displayName"
          label="Display name"
          autoComplete="username"
          hint="Shown on the leaderboard. Letters, numbers, - and _."
          value={form.values.displayName}
          error={form.errors.fields.displayName}
          onChange={(value) => form.setField('displayName', value)}
        />
        <TextField
          id="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 8 characters."
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
          {form.submitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthLayout>
  );
}
