import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { AuthProvider } from '../auth/session';
import { ToastProvider } from '../feedback/toasts';
import { ThemeProvider } from '../theme/theme';
import { sessionKey } from '../api/endpoints';

function renderAt(path: string) {
  return render(
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <MemoryRouter initialEntries={[path]}>
            <App />
          </MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>,
  );
}

describe('route protection', () => {
  beforeEach(() => localStorage.removeItem(sessionKey));

  it('sends unauthenticated visitors to sign in', async () => {
    renderAt('/dashboard');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });
});
