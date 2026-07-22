import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastOptions {
  message: string;
  variant?: ToastVariant;
  duration?: number;
  action?: ToastAction;
}

interface ToastItem extends ToastOptions {
  id: number;
  variant: ToastVariant;
  duration: number;
  createdAt: number;
}

interface ToastContextValue {
  show: (options: ToastOptions) => number;
  success: (message: string, options?: Omit<ToastOptions, 'message' | 'variant'>) => number;
  error: (message: string, options?: Omit<ToastOptions, 'message' | 'variant'>) => number;
  warning: (message: string, options?: Omit<ToastOptions, 'message' | 'variant'>) => number;
  info: (message: string, options?: Omit<ToastOptions, 'message' | 'variant'>) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const defaultDurations: Record<ToastVariant, number> = {
  success: 3000,
  info: 3500,
  warning: 4500,
  error: 5500,
};

const iconMap: Record<ToastVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
};

const iconColorMap: Record<ToastVariant, string> = {
  success: 'text-emerald-400',
  error: 'text-red-400',
  warning: 'text-amber-400',
  info: 'text-sky-400',
};

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const show = useCallback(
    (options: ToastOptions) => {
      const id = ++idRef.current;
      const variant = options.variant ?? 'info';
      const duration = options.duration ?? defaultDurations[variant];
      const item: ToastItem = {
        id,
        message: options.message,
        variant,
        duration,
        action: options.action,
        createdAt: Date.now(),
      };
      setToasts((prev) => [...prev, item].slice(-5));
      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timersRef.current.set(id, timer);
      }
      return id;
    },
    [dismiss]
  );

  useEffect(
    () => () => {
      timersRef.current.forEach((t) => clearTimeout(t));
      timersRef.current.clear();
    },
    []
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      dismiss,
      success: (message, options) => show({ ...options, message, variant: 'success' }),
      error: (message, options) => show({ ...options, message, variant: 'error' }),
      warning: (message, options) => show({ ...options, message, variant: 'warning' }),
      info: (message, options) => show({ ...options, message, variant: 'info' }),
    }),
    [show, dismiss]
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-x-0 bottom-28 z-[500] flex flex-col items-center gap-2 pointer-events-none px-4">
            <AnimatePresence initial={false}>
              {toasts.map((toast) => {
                const Icon = iconMap[toast.variant];
                return (
                  <motion.div
                    key={toast.id}
                    layout
                    initial={{ opacity: 0, y: 30, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 20, scale: 0.95, transition: { duration: 0.18 } }}
                    transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                    className="pointer-events-auto w-full max-w-md"
                    role="status"
                    aria-live="polite"
                  >
                    <div className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-slate-900/95 dark:bg-slate-800/95 text-white shadow-xl backdrop-blur-sm border border-white/10">
                      <Icon size={20} className={`shrink-0 ${iconColorMap[toast.variant]}`} />
                      <span className="flex-1 text-sm leading-relaxed whitespace-pre-line break-words">{toast.message}</span>
                      {toast.action && (
                        <button
                          onClick={() => {
                            toast.action?.onClick();
                            dismiss(toast.id);
                          }}
                          className="shrink-0 text-sm font-medium text-sky-300 hover:text-sky-200 px-2 py-1 rounded-full hover:bg-white/10 transition-colors"
                        >
                          {toast.action.label}
                        </button>
                      )}
                      <button
                        onClick={() => dismiss(toast.id)}
                        className="shrink-0 p-1 -mr-1 rounded-full text-white/60 hover:text-white hover:bg-white/10 transition-colors"
                        aria-label="关闭"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>,
          document.body
        )}
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextValue => {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast 必须在 ToastProvider 内使用');
  }
  return ctx;
};

let standaloneToast: ToastContextValue | null = null;
export const setStandaloneToast = (value: ToastContextValue) => {
  standaloneToast = value;
};
export const getStandaloneToast = (): ToastContextValue | null => standaloneToast;
