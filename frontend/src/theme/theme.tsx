import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';

const storageKey = 'leadpilot.theme';
const ThemeContext = createContext<{ choice: ThemeChoice; cycle: () => void; setChoice: (choice: ThemeChoice) => void } | null>(null);

function storedChoice(): ThemeChoice {
  const value = localStorage.getItem(storageKey);
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system';
}

export function resolveTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ThemeChoice>(storedChoice);

  useEffect(() => {
    localStorage.setItem(storageKey, choice);
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(choice);
      document.documentElement.dataset.themeChoice = choice;
    };
    apply();
    if (choice !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [choice]);

  const value = useMemo(() => ({
    choice,
    setChoice,
    cycle: () => setChoice((current) => (current === 'light' ? 'dark' : current === 'dark' ? 'system' : 'light')),
  }), [choice]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('ThemeProvider is required');
  return value;
}
