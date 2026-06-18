import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plus,
  Cpu,
  MessageSquare,
  Link2,
  Bell,
  FileText,
  Search
} from 'lucide-react';

interface FloatingActionsProps {
  onAction?: (actionId: string) => void;
}

const FloatingActions: React.FC<FloatingActionsProps> = ({ onAction }) => {
  const [isOpen, setIsOpen] = useState(false);

  const actions = [
    { id: 'createTask', icon: Plus, label: '创建任务', color: 'from-[#0b57d0] to-[#0d47a1]' },
    { id: 'cloudsaver', icon: Cpu, label: 'CloudSaver', color: 'from-[#7c3aed] to-[#5b21b6]' },
    { id: 'chat', icon: MessageSquare, label: 'AI 助手', color: 'from-[#ec4899] to-[#be185d]' },
    { id: 'strm', icon: Link2, label: 'STRM 生成', color: 'from-[#10b981] to-[#059669]' },
    { id: 'logs', icon: FileText, label: '实时日志', color: 'from-[#f59e0b] to-[#d97706]' },
  ];

  const handleAction = (id: string) => {
    if (onAction) onAction(id);
    setIsOpen(false);
  };

  return (
    <div className="fixed bottom-8 right-8 z-[100] flex flex-col items-end gap-4">
      <AnimatePresence>
        {isOpen && (
          <motion.div
            className="flex flex-col items-end gap-3 mb-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            {actions.map((action, index) => (
              <motion.button
                key={action.id}
                initial={{ opacity: 0, scale: 0.5, x: 20 }}
                animate={{ opacity: 1, scale: 1, x: 0 }}
                exit={{ opacity: 0, scale: 0.5, x: 20 }}
                transition={{
                  delay: index * 0.05,
                  type: 'spring',
                  stiffness: 400,
                  damping: 25
                }}
                whileHover={{ scale: 1.05, x: -4 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => handleAction(action.id)}
                className="flex items-center gap-3 group"
              >
                <motion.span
                  initial={{ opacity: 0, x: 10 }}
                  animate={{ opacity: 0, x: 10 }}
                  whileHover={{ opacity: 1, x: 0 }}
                  className="px-4 py-2.5 bg-white/95 backdrop-blur-sm dark:bg-slate-900/95 rounded-xl text-sm font-medium text-slate-700 dark:text-slate-200 shadow-lg border border-slate-200 dark:border-slate-700"
                >
                  {action.label}
                </motion.span>
                <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${action.color} text-white flex items-center justify-center shadow-lg hover:shadow-xl transition-shadow`}>
                  <action.icon size={22} />
                </div>
              </motion.button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        onClick={() => setIsOpen(!isOpen)}
        animate={{ rotate: isOpen ? 45 : 0 }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        className={`w-16 h-16 rounded-2xl bg-gradient-to-br from-[#0b57d0] to-[#0d47a1] text-white flex items-center justify-center shadow-xl hover:shadow-2xl transition-all duration-300 ${
          isOpen ? 'ring-4 ring-blue-200/50 dark:ring-blue-800/50' : ''
        }`}
      >
        <Plus size={32} />
      </motion.button>
    </div>
  );
};

export default FloatingActions;
