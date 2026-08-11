'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';

/**
 * App-wide, plain-language mutation feedback (PART B — visible feedback).
 * Presentation only: callers pass a finished sentence after their existing
 * save/create/link/delete call already succeeded — this never decides
 * whether an action happened, only whether the user is told about it.
 */
type ToastKind = 'success' | 'error';
type ToastItem = { id: number; message: string; kind: ToastKind };

const ToastContext = createContext<{ showToast: (message: string, kind?: ToastKind) => void } | null>(
  null,
);

let nextToastId = 1;
const TOAST_LIFETIME_MS = 4000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const showToast = useCallback(
    (message: string, kind: ToastKind = 'success') => {
      const id = nextToastId++;
      setToasts((current) => [...current, { id, message, kind }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), TOAST_LIFETIME_MS),
      );
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast${t.kind === 'error' ? ' toast-error' : ''}`}
            onClick={() => dismiss(t.id)}
            title="Dismiss"
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
