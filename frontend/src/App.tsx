import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/layout/AppShell';
import { LoginPage, RegisterPage } from './pages/AuthPages';
import { DashboardPage } from './pages/DashboardPage';
import { ExportsPage } from './pages/ExportsPage';
import { LeadDetailPage } from './pages/LeadDetailPage';
import { LeadsPage } from './pages/LeadsPage';
import { NewSearchPage } from './pages/NewSearchPage';
import { ResearchPage } from './pages/ResearchPage';
import { SearchExecutionPage } from './pages/SearchExecutionPage';
import { SearchHistoryPage } from './pages/SearchHistoryPage';
import { SearchProgressPage } from './pages/SearchProgressPage';
import { SettingsPage } from './pages/SettingsPage';
import { RequireAuth } from './routes/RequireAuth';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/search/new" element={<NewSearchPage />} />
          <Route path="/search/:searchId/execution/:executionId" element={<SearchExecutionPage />} />
          <Route path="/leads" element={<LeadsPage />} />
          <Route path="/leads/:companyId" element={<LeadDetailPage />} />
          <Route path="/search-history" element={<SearchHistoryPage />} />
          <Route path="/search-history/:searchId" element={<SearchProgressPage />} />
          <Route path="/research" element={<ResearchPage />} />
          <Route path="/exports" element={<ExportsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Route>
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
