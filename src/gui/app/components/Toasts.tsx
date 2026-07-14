import { createContext, useCallback, useContext, useRef, useState } from 'react';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'warn';
  message: string;
  /** When set, the toast shows an Undo button that fires this. */
  undo?: () => void | Promise<void>;
}

interface ToastApi {
  show: (t: Omit<Toast, 'id'>) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => {} });

export const useToasts = () => useContext(ToastContext);

const TOAST_MS = 6000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = nextId.current++;
      setToasts((ts) => [...ts.slice(-3), { ...t, id }]);
      window.setTimeout(() => dismiss(id), TOAST_MS);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div className={`toast toast-${t.kind}`} key={t.id}>
            <span className="toast-msg">{t.message}</span>
            {t.undo && (
              <button
                className="toast-undo"
                onClick={() => {
                  void t.undo!();
                  dismiss(t.id);
                }}
              >
                Undo
              </button>
            )}
            <button className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
