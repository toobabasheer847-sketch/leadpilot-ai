import { useAuth } from '../auth/session';
import { useTheme, type ThemeChoice } from '../theme/theme';

export function SettingsPage() {
  const { user, logout } = useAuth();
  const { choice, setChoice } = useTheme();
  return (
    <section className="stack">
      <div className="panel">
        <h2>Account</h2>
        <p>{user?.name ?? 'Not Found'}</p>
        <p>{user?.email ?? 'Not Found'}</p>
        <p>{user?.organization.name ?? 'Not Found'}</p>
        <p>Role: {user?.role ?? 'Not Found'}</p>
        <button type="button" onClick={logout}>Log out</button>
      </div>
      <div className="panel">
        <h2>Appearance</h2>
        <label htmlFor="theme">Theme</label>
        <select id="theme" value={choice} onChange={(event) => setChoice(event.target.value as ThemeChoice)}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="system">System</option>
        </select>
      </div>
    </section>
  );
}
