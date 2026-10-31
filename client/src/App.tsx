import { BrowserRouter } from 'react-router';
import { AppShell } from './components/AppShell.tsx';
import { AccountProvider } from './context/AccountContext.tsx';
import { AuthProvider } from './context/AuthContext.tsx';
import { RealtimeProvider } from './context/RealtimeContext.tsx';
import { ToastProvider } from './context/ToastContext.tsx';

export function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <RealtimeProvider>
          <AuthProvider>
            <AccountProvider>
              <AppShell />
            </AccountProvider>
          </AuthProvider>
        </RealtimeProvider>
      </ToastProvider>
    </BrowserRouter>
  );
}
