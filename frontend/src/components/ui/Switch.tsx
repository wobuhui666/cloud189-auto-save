import { ReactNode, useId } from 'react';

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  size?: 'sm' | 'md';
  labelPosition?: 'left' | 'right';
  className?: string;
}

const sizeMap = {
  sm: {
    track: 'w-9 h-5',
    knob: 'after:h-4 after:w-4 after:top-[2px] after:left-[2px]',
  },
  md: {
    track: 'w-11 h-6',
    knob: "after:h-5 after:w-5 after:top-[2px] after:left-[2px]",
  },
};

export const Switch = ({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  size = 'md',
  labelPosition = 'left',
  className = '',
}: SwitchProps) => {
  const { track, knob } = sizeMap[size];
  const id = useId();

  const trackEl = (
    <span
      className={`relative inline-flex items-center shrink-0 ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      }`}
    >
      <input
        id={id}
        type="checkbox"
        className="sr-only peer"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        className={`${track} bg-slate-200 dark:bg-slate-700 peer-focus-visible:ring-2 peer-focus-visible:ring-[#0b57d0]/30 peer-focus-visible:ring-offset-2 rounded-full peer transition-colors after:content-[''] after:absolute after:bg-white after:rounded-full after:shadow-sm after:transition-all peer-checked:after:translate-x-full peer-checked:bg-[#0b57d0] ${knob}`}
      />
    </span>
  );

  if (!label && !description) {
    return (
      <label className={`relative inline-flex items-center ${className}`}>
        {trackEl}
      </label>
    );
  }

  return (
    <label
      htmlFor={id}
      className={`flex items-center gap-3 cursor-pointer ${
        disabled ? 'cursor-not-allowed opacity-60' : ''
      } ${labelPosition === 'right' ? 'flex-row' : 'flex-row-reverse justify-between'} ${className}`}
    >
      {trackEl}
      <span className="flex flex-col gap-0.5 select-none min-w-0">
        {label && (
          <span className="text-sm font-medium text-[var(--text-primary)]">{label}</span>
        )}
        {description && (
          <span className="text-xs text-[var(--text-secondary)] leading-relaxed">{description}</span>
        )}
      </span>
    </label>
  );
};

export default Switch;
