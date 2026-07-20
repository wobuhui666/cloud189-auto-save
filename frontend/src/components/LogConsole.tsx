import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, Terminal, Trash2, Wifi, WifiOff } from 'lucide-react';
import Modal from './Modal';
import Checkbox from './ui/Checkbox';

interface LogConsoleProps {
  isOpen: boolean;
  onClose: () => void;
}

type LogLevel = 'error' | 'warn' | 'success' | 'info';
type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

interface ParsedLog {
  id: number;
  level: LogLevel;
  timestamp: string;
  message: string;
}

const LOG_TIMESTAMP_PATTERN = /^\[([^\]]+)\]\s*(.*)$/;

const LOG_LEVEL_META = {
  error: {
    label: '错误',
    icon: AlertCircle,
    badgeClass: 'bg-[#f9dedc] text-[#b3261e] dark:bg-red-500/15 dark:text-red-300',
    rowClass: 'border-l-[#b3261e]',
    dotClass: 'bg-[#b3261e]'
  },
  warn: {
    label: '警告',
    icon: AlertCircle,
    badgeClass: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
    rowClass: 'border-l-amber-500',
    dotClass: 'bg-amber-500'
  },
  success: {
    label: '成功',
    icon: CheckCircle2,
    badgeClass: 'bg-[#c4eed0] text-[#146c2e] dark:bg-emerald-500/15 dark:text-emerald-300',
    rowClass: 'border-l-[#146c2e]',
    dotClass: 'bg-[#146c2e]'
  },
  info: {
    label: '信息',
    icon: Info,
    badgeClass: 'bg-[#d3e3fd] text-[#0b57d0] dark:bg-blue-500/15 dark:text-blue-300',
    rowClass: 'border-l-[#0b57d0]',
    dotClass: 'bg-[#0b57d0]'
  }
} as const;

const parseLogLevel = (log: string): Omit<ParsedLog, 'id'> => {
  const timestampMatch = log.match(LOG_TIMESTAMP_PATTERN);
  const message = (timestampMatch?.[2] || log).trim();
  const normalizedMessage = message.toLowerCase();

  // 统计字段里的「失败数: 0 / 成功数: 1」不能当错误；先剥离后再判定
  const messageForLevel = normalizedMessage
    .replace(/失败数\s*[：:]\s*\d+/g, ' ')
    .replace(/成功数\s*[：:]\s*\d+/g, ' ')
    .replace(/跳过数\s*[：:]\s*\d+/g, ' ')
    .replace(/总文件数\s*[：:]\s*\d+/g, ' ')
    .replace(/failed\s*[:=]\s*\d+/gi, ' ')
    .replace(/success(?:es)?\s*[:=]\s*\d+/gi, ' ')
    .replace(/skipped\s*[:=]\s*\d+/gi, ' ');

  let level: LogLevel = 'info';
  // 明确成功完成优先（避免 “完成, 失败数: 0” 被失败关键字误伤）
  if (/success|completed|complete|成功|完成|已完结/.test(messageForLevel) && !/(失败|错误|异常|error|failed|fail|exception)/.test(messageForLevel)) {
    level = 'success';
  } else if (/(error|failed|fail|exception|错误|失败|异常)/.test(messageForLevel)) {
    // 若同时有成功完成语义且失败计数为 0，仍算成功
    const failedCountMatch = normalizedMessage.match(/失败数\s*[：:]\s*(\d+)/);
    const failedCount = failedCountMatch ? Number(failedCountMatch[1]) : null;
    if (failedCount === 0 && /(成功|完成|completed|success)/.test(normalizedMessage)) {
      level = 'success';
    } else {
      level = 'error';
    }
  } else if (/warn|warning|警告|告警/.test(messageForLevel)) {
    level = 'warn';
  } else if (/success|completed|complete|成功|完成|已完结/.test(messageForLevel)) {
    level = 'success';
  }

  return {
    level,
    timestamp: timestampMatch?.[1] || '--',
    message
  };
};

const LogConsole: React.FC<LogConsoleProps> = ({ isOpen, onClose }) => {
  const [logs, setLogs] = useState<ParsedLog[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const logSeqRef = useRef(0);
  const isOpenRef = useRef(isOpen);
  isOpenRef.current = isOpen;

  const errorCount = useMemo(() => logs.filter(log => log.level === 'error').length, [logs]);
  const warnCount = useMemo(() => logs.filter(log => log.level === 'warn').length, [logs]);

  useEffect(() => {
    if (!isOpen) {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      reconnectAttemptRef.current = 0;
      setConnectionState('disconnected');
      return;
    }

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const appendLogs = (messages: string[], replace = false) => {
      const parsed = messages.map((message) => {
        logSeqRef.current += 1;
        return {
          id: logSeqRef.current,
          ...parseLogLevel(message)
        };
      });

      setLogs((prev) => {
        const next = replace ? parsed : [...prev, ...parsed];
        return next.slice(-500);
      });
    };

    const connect = () => {
      if (!isOpenRef.current) {
        return;
      }

      clearReconnectTimer();
      eventSourceRef.current?.close();

      setConnectionState(reconnectAttemptRef.current > 0 ? 'reconnecting' : 'connecting');
      const eventSource = new EventSource('/api/logs/events');
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        if (!isOpenRef.current) {
          eventSource.close();
          return;
        }
        reconnectAttemptRef.current = 0;
        setConnectionState('connected');
      };

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'history') {
            appendLogs(Array.isArray(data.logs) ? data.logs.slice(-500).map(String) : [], true);
            return;
          }
          if (data.type === 'log' && data.message) {
            appendLogs([String(data.message)]);
          }
        } catch (error) {
          console.error('解析日志 SSE 消息失败:', error);
        }
      };

      eventSource.onerror = () => {
        eventSource.close();
        if (eventSourceRef.current === eventSource) {
          eventSourceRef.current = null;
        }
        if (!isOpenRef.current) {
          setConnectionState('disconnected');
          return;
        }

        setConnectionState('reconnecting');
        const attempt = reconnectAttemptRef.current;
        const delay = Math.min(10000, 1000 * Math.pow(2, Math.min(attempt, 3)));
        reconnectAttemptRef.current = attempt + 1;
        clearReconnectTimer();
        reconnectTimerRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      clearReconnectTimer();
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
      reconnectAttemptRef.current = 0;
      setConnectionState('disconnected');
    };
  }, [isOpen]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const clearLogs = () => setLogs([]);
  const isConnected = connectionState === 'connected';

  const connectionLabel =
    connectionState === 'connecting'
      ? '连接中'
      : connectionState === 'reconnecting'
        ? '重连中'
        : isConnected
          ? '实时同步'
          : '已断开';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="系统实时日志"
      maxWidthClass="max-w-5xl"
      contentClassName="px-5 md:px-8 pb-6 max-h-[70vh] overflow-y-auto custom-scrollbar"
      footer={
        <div className="px-5 md:px-8 py-4 flex flex-col gap-4 border-t border-[var(--modal-border)] bg-white/70 dark:bg-slate-900/60 sm:flex-row sm:items-center sm:justify-between">
          <Checkbox
            size="sm"
            checked={autoScroll}
            onChange={setAutoScroll}
            label="自动滚动"
            labelClassName="text-sm text-[var(--text-secondary)]"
          />
          <div className="flex items-center justify-end gap-3">
            <button
              onClick={clearLogs}
              className="p-2.5 hover:bg-red-50 text-red-500 rounded-full transition-colors dark:hover:bg-red-500/10"
              title="清空显示"
              aria-label="清空显示"
            >
              <Trash2 size={20} />
            </button>
            <button
              onClick={onClose}
              className="px-6 py-2 bg-[#0b57d0] text-white rounded-full text-sm font-medium hover:bg-[#0b57d0]/90 transition-all"
            >
              关闭
            </button>
          </div>
        </div>
      }
    >
      <div className="space-y-4 pt-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-2xl border border-[var(--modal-border)] bg-white px-4 py-3 dark:bg-slate-900/60">
            <div className="text-xs text-[var(--text-secondary)]">连接状态</div>
            <div className="mt-2 flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
              {isConnected ? <Wifi size={18} className="text-[#146c2e]" /> : <WifiOff size={18} className="text-slate-400" />}
              {connectionLabel}
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--modal-border)] bg-white px-4 py-3 dark:bg-slate-900/60">
            <div className="text-xs text-[var(--text-secondary)]">日志条数</div>
            <div className="mt-1 text-2xl font-semibold text-[var(--text-primary)]">{logs.length}</div>
          </div>
          <div className="rounded-2xl border border-[var(--modal-border)] bg-white px-4 py-3 dark:bg-slate-900/60">
            <div className="text-xs text-[var(--text-secondary)]">警告</div>
            <div className="mt-1 text-2xl font-semibold text-amber-600 dark:text-amber-300">{warnCount}</div>
          </div>
          <div className="rounded-2xl border border-[var(--modal-border)] bg-white px-4 py-3 dark:bg-slate-900/60">
            <div className="text-xs text-[var(--text-secondary)]">错误</div>
            <div className="mt-1 text-2xl font-semibold text-[#b3261e] dark:text-red-300">{errorCount}</div>
          </div>
        </div>

        <div
          ref={scrollRef}
          className="h-[430px] overflow-y-auto rounded-2xl border border-[var(--modal-border)] bg-white p-3 custom-scrollbar dark:bg-slate-950/40"
        >
          {logs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center text-center text-[var(--text-secondary)]">
              <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-[#d3e3fd] text-[#0b57d0] dark:bg-[#0b57d0]/20 dark:text-blue-300">
                <Terminal size={28} />
              </div>
              <div className="text-sm font-medium text-[var(--text-primary)]">等待日志输出</div>
              <div className="mt-1 text-xs">系统运行事件会实时显示在这里</div>
            </div>
          ) : (
            <div className="space-y-2">
              {logs.map((log) => {
                const meta = LOG_LEVEL_META[log.level];
                const LogIcon = meta.icon;

                return (
                  <div
                    key={log.id}
                    className={`grid gap-3 rounded-xl border border-slate-100 border-l-4 bg-slate-50/70 px-3 py-2.5 transition-colors hover:bg-slate-100/80 dark:border-slate-800 dark:bg-slate-900/70 dark:hover:bg-slate-900 ${meta.rowClass}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold ${meta.badgeClass}`}>
                        <LogIcon size={13} />
                        {meta.label}
                      </span>
                      <span className="font-mono text-xs text-[var(--text-secondary)]">{log.timestamp}</span>
                      <span className={`h-1.5 w-1.5 rounded-full ${meta.dotClass}`} />
                    </div>
                    <p className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-slate-700 dark:text-slate-200">
                      {log.message}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

export default LogConsole;
