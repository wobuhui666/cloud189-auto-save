import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { lockBodyScroll, unlockBodyScroll } from '../lib/bodyScrollLock';
import { pushOverlay, popOverlay } from '../lib/overlayStack';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidthClass?: string;
  contentClassName?: string;
}

const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidthClass = 'max-w-2xl',
  contentClassName = 'px-8 pb-6 max-h-[60vh] overflow-y-auto'
}) => {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    lockBodyScroll();
    const overlayId = pushOverlay({
      kind: 'modal',
      onEscape: () => onCloseRef.current()
    });

    return () => {
      popOverlay(overlayId);
      unlockBodyScroll();
    };
  }, [isOpen]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-[200]"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            role="dialog"
            aria-modal="true"
            className={`fixed left-1/2 top-1/2 flex max-h-[calc(100vh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col ${maxWidthClass} rounded-[28px] border border-[var(--modal-border)] bg-[var(--modal-bg)] text-[var(--text-primary)] shadow-2xl z-[201] overflow-hidden`}
          >
            <div className="px-8 py-6 flex shrink-0 items-center justify-between border-b border-[var(--modal-border)]">
              <h3 className="text-2xl font-normal text-[var(--text-primary)]">{title}</h3>
              <button
                onClick={onClose}
                className="p-2 hover:bg-slate-200/50 dark:hover:bg-slate-800/60 rounded-full transition-colors text-[var(--text-secondary)]"
                aria-label="关闭"
              >
                <X size={24} />
              </button>
            </div>
            <div className={contentClassName}>{children}</div>
            {footer !== undefined ? (
              <div className="shrink-0">{footer}</div>
            ) : (
              <div className="px-8 py-6 flex shrink-0 justify-end gap-3">
                <button
                  onClick={onClose}
                  className="px-6 py-2.5 rounded-full text-sm font-medium text-[#0b57d0] hover:bg-[#0b57d0]/10 transition-colors"
                >
                  取消
                </button>
                {/* 兼容 AccountTab / SubscriptionTab 的 id="modal-form"；无目标 form 时不提交 */}
                <button
                  type="submit"
                  form="modal-form"
                  onClick={(event) => {
                    if (!document.getElementById('modal-form')) {
                      event.preventDefault();
                    }
                  }}
                  className="px-6 py-2.5 rounded-full text-sm font-medium bg-[#0b57d0] text-white hover:bg-[#0b57d0]/90 transition-colors shadow-sm"
                >
                  确认提交
                </button>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default Modal;
