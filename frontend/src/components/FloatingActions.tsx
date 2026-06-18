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
    { id: 'createTask', icon: Plus, label: '创建任务', color: 'bg-[#0b57d0] text-white' },
    { id: 'cloudsaver', icon: Cpu, label: 'CloudSaver', color: 'bg-[#d3e3fd] text-[#0b57d0]' },
    { id: 'chat', icon: MessageSquare, label: 'AI 助手', color: 'bg-[#f3e8ff] text-[#7e22ce]' },
    { id: 'strm', icon: Link2, label: 'STRM 生成', color: 'bg-[#c4eed0] text-[#146c2e]' },
    { id: 'logs', icon: FileText, label: '实时日志', color: 'bg-slate-200 text-slate-700' },
  ];

  const handleAction = (id: string) => {
    if (onAction) onAction(id);
    setIsOpen(false);
  };

  return (
    <div className="fixed bottom-8 right-8 z-[100] flex flex-col items-end gap-4">
      <AnimatePresence>
        {isOpen && (
          <div className="flex flex-col items-end gap-3 mb-2">
            {actions.map((action, index) => (
              <motion.button
                key={action.id}
                initial={{ opacity: 0, scale: 0.5, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.5, y: 20 }}
                transition={{ delay: index * 0.05 }}
                onClick={() => handleAction(action.id)}
                className="flex items-center gap-3 group"
              >
                <span className="px-4 py-2 bg-white rounded-xl text-sm font-medium text-slate-700 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity">
                  {action.label}
                </span>
                <div className={`w-14 h-14 rounded-2xl ${action.color} flex items-center justify-center shadow-sm hover:shadow-md hover:scale-105 transition-all`}>
                  <action.icon size={24} />
                </div>
              </motion.button>
            ))}
          </div>
        )}
      </AnimatePresence>

      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`w-16 h-16 rounded-2xl ${isOpen ? 'bg-[#d3e3fd] text-[#041e49] rotate-45' : 'bg-[#0b57d0] text-white'} flex items-center justify-center shadow-lg transition-all duration-300 hover:shadow-xl active:scale-95`}
      >
        <Plus size={32} className="transition-transform" />
      </button>
    </div>
  );
};

export default FloatingActions;
