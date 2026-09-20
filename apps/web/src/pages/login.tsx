import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { api } from '@/api/client';
import { keys, useSession } from '@/api/hooks';
import { Logo, ThemeToggle } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { FieldError, Input, Label } from '@/components/ui/input';
import { describeError } from '@/components/ui/states';
import { useDocumentTitle } from '@/lib/use-document-title';

/** Only follow redirects to paths inside the app. */
function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export function LoginPage() {
  useDocumentTitle('Sign in · QA Hub');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api.login({ email, password }),
    onSuccess: (data) => {
      client.setQueryData(keys.session, data);
      void navigate(safeNext(params.get('next')), { replace: true });
    },
  });

  if (session.data) return <Navigate to={safeNext(params.get('next'))} replace />;

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (!login.isPending) login.mutate();
  }

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="mb-8 flex flex-col items-center gap-3">
        <Logo className="size-11" />
        <div className="text-center">
          <h1 className="text-xl font-semibold text-fg">Sign in to QA Hub</h1>
          <p className="mt-1 text-[13px] text-muted">
            Check live sites for broken things after launch.
          </p>
        </div>
      </div>
      <Card className="w-full max-w-sm">
        <CardContent>
          <form onSubmit={submit} className="space-y-4" noValidate>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                autoFocus
                required
                className="mt-1.5"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                className="mt-1.5"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-invalid={login.isError || undefined}
                aria-describedby={login.isError ? 'login-error' : undefined}
              />
              {login.isError ? (
                <FieldError id="login-error">{describeError(login.error)}</FieldError>
              ) : null}
            </div>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full"
              loading={login.isPending}
              disabled={email === '' || password === ''}
            >
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
