import { FormEvent, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/session';
import { Field } from '../components/feedback/States';

export function LoginPage() {
  const { status, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = (location.state as { from?: string } | null)?.from || '/dashboard';
  if (status === 'authenticated') return <Navigate to="/dashboard" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      navigate(next);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Unable to sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <form className="panel auth-card" onSubmit={(event) => void submit(event)}>
        <h1>Sign in</h1>
        <Field label="Email"><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
        <Field label="Password"><input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={busy}>{busy ? 'Signing in' : 'Sign in'}</button>
        <p>New organization? <Link to="/register">Create an account</Link></p>
      </form>
    </main>
  );
}

export function RegisterPage() {
  const { status, register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', organizationName: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (status === 'authenticated') return <Navigate to="/dashboard" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (form.password.length < 12) {
      setError('Password must be at least 12 characters.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await register(form);
      navigate('/dashboard');
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : 'Unable to create the account.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-screen">
      <form className="panel auth-card" onSubmit={(event) => void submit(event)}>
        <h1>Create account</h1>
        <Field label="Name"><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
        <Field label="Email"><input type="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
        <Field label="Organization"><input required value={form.organizationName} onChange={(event) => setForm({ ...form, organizationName: event.target.value })} /></Field>
        <Field label="Password"><input type="password" required minLength={12} value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
        {error ? <p role="alert">{error}</p> : null}
        <button type="submit" disabled={busy}>{busy ? 'Creating account' : 'Create account'}</button>
        <p>Already registered? <Link to="/login">Sign in</Link></p>
      </form>
    </main>
  );
}
