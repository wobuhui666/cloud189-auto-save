import React, { createContext, useCallback, useContext, useMemo, useRef, useState, ReactNode, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, HelpCircle, Info, AlertOctagon } from 'lucide-react';

export type DialogTone = 'info' | 'danger' | 'warning' | 'success';

interface BaseDialogOptions {
  title?: ReactNode;
  message?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: DialogTone;
  icon?: ReactNode;
}

interface ConfirmOptions extends BaseDialogOptions {}

interface PromptOptions extends BaseDialogOptions {
  defaultValue?: string;
  placeholder?: string;
  validate?: (value: string) => string | null | undefined;
  multiline?: boolean;
  inputType?: 'text' | 'password' | 'number' | 'email' | 'url';
}

interface DialogContextValue {
  confirm: (options: ConfirmOptions | string) => Promise<boolean>;
  prompt: (options: PromptOptions | string) => Promise<string | null>;
  alert: (options: BaseDialogOptions | string) => Promise<void>;
}

const DialogContext = createContext<DialogContextValue | null>(null);

interface DialogState {
  id: number;
  type: 'confirm' | 'prompt' | 'alert';
  resolve: (value: any) => void;
  options: ConfirmOptions & PromptOptions;
}

const toneIconMap: Record<DialogTone, typeof AlertTriangle> = {
  info: Info,
  warning: AlertTriangle,
  danger: AlertOctagon,
  success: HelpCircle,
};

const toneStyleMap: Record<DialogTone, { iconBg: string; iconColor: string; confirmBg: string }> = {
  info: {
    iconBg: 'bg-[#e8f0fe] dark:bg-[#0b57d0]/15',
    iconColor: 'text-[#0b57d0]',
    confirmBg: 'bg-[#0b57d0] hover:bg-[#0b57d0]/90 text-white',
  },
  warning: {
    iconBg: 'bg-amber-50 dark:bg-amber-500/15',
    iconColor: 'text-amber-600 dark:text-amber-400',
    confirmBg: 'bg-amber-600 hover:bg-amber-500 text-white',
  },
  danger: {
    iconBg: 'bg-red-50 dark:bg-red-500/15',
    iconColor: 'text-red-600 dark:text-red-400',
    confirmBg: 'bg-red-600 hover:bg-red-500 text-white',
  },
  success: {
    iconBg: 'bg-emerald-50 dark:bg-emerald-500/15',
    iconColor: 'text-emerald-600 dark:text-emerald-400',
    confirmBg: 'bg-emerald-600 hover:bg-emerald-500 text-white',
  },
};

export const DialogProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [dialogs, setDialogs] = useState<DialogState[]>([]);
  const idRef = useRef(0);

  const close = useCallback((id: number, value: any) => {
    setDialogs((prev) => {
      const target = prev.find((d) => d.id === id);
      if (target) target.resolve(value);
      return prev.filter((d) => d.id !== id);
    });
  }, []);

  const open = useCallback(
    <T,>(type: DialogState['type'], options: ConfirmOptions & PromptOptions): Promise<T> => {
      return new Promise<T>((resolve) => {
        const id = ++idRef.current;
        setDialogs((prev) => [...prev, { id, type, resolve, options }]);
      });
    },
    []
  );

  const normalize = (input: any): ConfirmOptions & PromptOptions => {
    if (typeof input === 'string') return { message: input };
    return input ?? {};
  };

  const value = useMemo<DialogContextValue>(
    () => ({
      confirm: (opts) => open<boolean>('confirm', normalize(opts)),
      prompt: (opts) => open<string | null>('prompt', normalize(opts)),
      alert: (opts) => open<void>('alert', normalize(opts)),
    }),
    [open]
  );

  return (
    <DialogContext.Provider value={value}>
      {children}
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {dialogs.map((dialog) => (
              <DialogRenderer key={dialog.id} dialog={dialog} onClose={(v) => close(dialog.id, v)} />
            ))}
          </AnimatePresence>,
          document.body
        )}
    </DialogContext.Provider>
  );
};

interface RendererProps {
  dialog: DialogState;
  onClose: (value: any) => void;
}

const DialogRenderer: React.FC<RendererProps> = ({ dialog, onClose }) => {
  const { type, options } = dialog;
  const tone: DialogTone = options.tone ?? (type === 'alert' ? 'info' : 'info');
  const Icon = toneIconMap[tone];
  const styles = toneStyleMap[tone];

  const [value, setValue] = useState(options.defaultValue ?? '');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (type === 'prompt' && inputRef.current) {
      const timer = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(timer);
    }
  }, [type]);

  const handleCancel = () => {
    if (type === 'confirm') onClose(false);
    else if (type === 'prompt') onClose(null);
    else onClose(undefined);
  };

  const handleConfirm = () => {
    if (type === 'confirm') onClose(true);
    else if (type === 'prompt') {
      if (options.validate) {
        const err = options.validate(value);
        if (err) {
          setError(err);
          return;
        }
      }
      onClose(value);
    } else {
      onClose(undefined);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel();
      else if (e.key === 'Enter' && type !== 'prompt') handleConfirm();
      else if (e.key === 'Enter' && type === 'prompt' && !options.multiline && !e.shiftKey) {
        e.preventDefault();
        handleConfirm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const confirmText = options.confirmText ?? (type === 'prompt' ? '确定' : type === 'alert' ? '知道了' : '确认');
  const cancelText = options.cancelText ?? '取消';

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={handleCancel}
        className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[400]"
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30 }}
        role="dialog"
        aria-modal="true"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] max-w-md rounded-[28px] border border-[var(--modal-border)] bg-[var(--modal-bg)] text-[var(--text-primary)] shadow-2xl z-[401] overflow-hidden"
      >
        <div className="px-6 pt-6 pb-2 flex items-start gap-4">
          {options.icon !== null && (
            <div className={`shrink-0 w-11 h-11 rounded-full flex items-center justify-center ${styles.iconBg}`}>
              {options.icon ?? <Icon size={22} className={styles.iconColor} />}
            </div>
          )}
          <div className="flex-1 min-w-0 pt-0.5">
            {options.title && (
              <h3 className="text-lg font-medium text-[var(--text-primary)] mb-1.5 leading-snug">{options.title}</h3>
            )}
            {options.message && (
              <div className="text-sm text-[var(--text-secondary)] leading-relaxed whitespace-pre-line">{options.message}</div>
            )}
          </div>
        </div>

        {type === 'prompt' && (
          <div className="px-6 pt-2 pb-1">
            {options.multiline ? (
              <textarea
                ref={(el) => {
                  inputRef.current = el;
                }}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (error) setError(null);
                }}
                placeholder={options.placeholder}
                rows={3}
                className={`w-full px-4 py-3 bg-slate-50 dark:bg-slate-800/60 border rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 resize-none ${
                  error ? 'border-red-400' : 'border-slate-300 dark:border-slate-700'
                }`}
              />
            ) : (
              <input
                ref={(el) => {
                  inputRef.current = el;
                }}
                type={options.inputType ?? 'text'}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (error) setError(null);
                }}
                placeholder={options.placeholder}
                className={`w-full px-4 py-3 bg-slate-50 dark:bg-slate-800/60 border rounded-2xl text-sm outline-none focus:ring-2 focus:ring-[#0b57d0]/20 ${
                  error ? 'border-red-400' : 'border-slate-300 dark:border-slate-700'
                }`}
              />
            )}
            {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
          </div>
        )}

        <div className="px-4 py-4 flex justify-end gap-2">
          {type !== 'alert' && (
            <button
              onClick={handleCancel}
              className="px-5 py-2.5 rounded-full text-sm font-medium text-[#0b57d0] hover:bg-[#0b57d0]/10 transition-colors"
            >
              {cancelText}
            </button>
          )}
          <button
            onClick={handleConfirm}
            className={`px-5 py-2.5 rounded-full text-sm font-medium shadow-sm transition-colors ${styles.confirmBg}`}
          >
            {confirmText}
          </button>
        </div>
      </motion.div>
    </>
  );
};

export const useDialog = (): DialogContextValue => {
  const ctx = useContext(DialogContext);
  if (!ctx) {
    throw new Error('useDialog 必须在 DialogProvider 内使用');
  }
  return ctx;
};

let standaloneDialog: DialogContextValue | null = null;
export const setStandaloneDialog = (value: DialogContextValue) => {
  standaloneDialog = value;
};
export const getStandaloneDialog = (): DialogContextValue | null => standaloneDialog;
