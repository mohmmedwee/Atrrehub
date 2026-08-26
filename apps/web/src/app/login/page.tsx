'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ApiError, api, tokens } from '@/lib/api';
import { Button, Field, inputClass } from '@/components/ui';
import type { Session } from '@/lib/types';

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({
    email: '',
    password: '',
    mfaCode: '',
    firstName: '',
    lastName: '',
    organizationName: '',
  });
  const [mfaRequired, setMfaRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const session =
        mode === 'login'
          ? await api<Session>('/auth/login', {
              method: 'POST',
              retryOnUnauthorized: false,
              body: {
                email: form.email,
                password: form.password,
                ...(form.mfaCode ? { mfaCode: form.mfaCode } : {}),
              },
            })
          : await api<Session>('/auth/register', {
              method: 'POST',
              retryOnUnauthorized: false,
              body: {
                email: form.email,
                password: form.password,
                firstName: form.firstName,
                lastName: form.lastName,
                organizationName: form.organizationName,
              },
            });

      tokens.set(session.accessToken, session.refreshToken);
      router.replace('/workspace');
    } catch (caught) {
      if (caught instanceof ApiError) {
        // A required second factor is a step in the flow, not a failure.
        const meta = (caught.problem as unknown as { meta?: { mfaRequired?: boolean } }).meta;
        if (meta?.mfaRequired) {
          setMfaRequired(true);
          setError('Enter the code from your authenticator app');
        } else {
          setError(caught.problem.errors?.[0]?.message ?? caught.problem.detail);
        }
      } else {
        setError('Could not reach the server');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Atrrehub</h1>
          <p className="mt-1 text-sm text-text-muted">AI-native contact center platform</p>
        </div>

        <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-surface p-5">
          {mode === 'register' ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="First name">
                  <input className={inputClass} value={form.firstName} onChange={update('firstName')} required autoComplete="given-name" />
                </Field>
                <Field label="Last name">
                  <input className={inputClass} value={form.lastName} onChange={update('lastName')} required autoComplete="family-name" />
                </Field>
              </div>
              <Field label="Organization">
                <input className={inputClass} value={form.organizationName} onChange={update('organizationName')} required placeholder="Acme Support" />
              </Field>
            </>
          ) : null}

          <Field label="Email">
            <input className={inputClass} type="email" value={form.email} onChange={update('email')} required autoComplete="email" />
          </Field>

          <Field label="Password" hint={mode === 'register' ? 'At least 12 characters, with upper case, lower case and a digit' : undefined}>
            <input
              className={inputClass}
              type="password"
              value={form.password}
              onChange={update('password')}
              required
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
          </Field>

          {mfaRequired ? (
            <Field label="Authentication code">
              <input className={inputClass} value={form.mfaCode} onChange={update('mfaCode')} inputMode="numeric" autoComplete="one-time-code" />
            </Field>
          ) : null}

          {error ? (
            <p role="alert" className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
              {error}
            </p>
          ) : null}

          <Button type="submit" disabled={busy} full>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create organization'}
          </Button>

          <button
            type="button"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError(null);
              setMfaRequired(false);
            }}
            className="w-full text-center text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
          >
            {mode === 'login' ? 'Create a new organization' : 'I already have an account'}
          </button>
        </form>
      </div>
    </main>
  );
}
