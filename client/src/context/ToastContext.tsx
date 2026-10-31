import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

export type ToastVariant = 'success' | 'danger' | 'warning' | 'info';

export interface Toast {
  id: number;
  variant: ToastVariant;
  title: string;
  body?: string;
}

interface ToastValue {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastValue | null>(null);
const TOAST_DURATION_MS = 5_000;
const MAX_TOASTS = 5;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (toast: Omit<Toast, 'id'>) => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current, { ...toast, id }].slice(-MAX_TOASTS));
      setTimeout(() => dismiss(id), TOAST_DURATION_MS);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toasts, push, dismiss }), [toasts, push, dismiss]);
  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToasts(): ToastValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToasts must be used inside <ToastProvider>');
  return value;
}
