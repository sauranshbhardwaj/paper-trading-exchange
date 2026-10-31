import { useToasts } from '../context/ToastContext.tsx';

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="toast-container position-fixed bottom-0 end-0 p-3" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast show tilt-toast tilt-toast-${toast.variant}`}
          role="alert"
        >
          <div className="toast-header">
            <strong className="me-auto">{toast.title}</strong>
            <button
              type="button"
              className="btn-close btn-close-white"
              aria-label="Dismiss"
              onClick={() => dismiss(toast.id)}
            />
          </div>
          {toast.body && <div className="toast-body">{toast.body}</div>}
        </div>
      ))}
    </div>
  );
}
