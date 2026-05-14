import { ReactNode } from 'react';

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

  const trackEl = (
    <label
      className={`relative inline-flex items-center ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      } ${className}`}
    >
      <input
        type="checkbox"
        className="sr-only peer"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div
        className={`${track} bg-slate-200 dark:bg-slate-700 peer-focus-visible:ring-2 peer-focus-visible:ring-[#0b57d0]/30 peer-focus-visible:ring-offset-2 rounded-full peer transition-colors after:content-[''] after:absolute after:bg-white after:rounded-full after:shadow-sm after:transition-all peer-checked:after:translate-x-full peer-checked:bg-[#0b57d0] ${knob}`}
      />
    </label>
  );

  if (!label && !description) return trackEl;

  return (
    <div className={`flex items-center gap-3 ${labelPosition === 'right' ? 'flex-row' : 'flex-row-reverse justify-between'}`}>
      {trackEl}
      <div className="flex flex-col gap-0.5 select-none">
        {label && <span className="text-sm font-medium text-slate-900 dark:text-slate-100">{label}</span>}
        {description && (
          <span className="text-xs text-slate-500 leading-relaxed">{description}</span>
        )}
      </div>
    </div>
  );
};

export default Switch;
