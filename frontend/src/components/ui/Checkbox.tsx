import { Check, Minus } from 'lucide-react';
import { ReactNode } from 'react';

interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  indeterminate?: boolean;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  labelClassName?: string;
  align?: 'center' | 'start';
}

const sizeMap = {
  sm: { box: 'w-4 h-4', icon: 12 },
  md: { box: 'w-5 h-5', icon: 14 },
  lg: { box: 'w-6 h-6', icon: 16 },
};

export const Checkbox = ({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  indeterminate = false,
  size = 'md',
  className = '',
  labelClassName = 'text-sm font-medium text-slate-700',
  align = 'center',
}: CheckboxProps) => {
  const { box, icon } = sizeMap[size];
  const isActive = checked || indeterminate;

  const handleToggle = () => {
    if (disabled) return;
    onChange(!checked);
  };

  return (
    <label
      className={`inline-flex ${align === 'center' ? 'items-center' : 'items-start'} gap-3 group ${
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      } ${className}`}
      onClick={(e) => {
        e.preventDefault();
        handleToggle();
      }}
    >
      <span
        role="checkbox"
        aria-checked={indeterminate ? 'mixed' : checked}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            handleToggle();
          }
        }}
        className={`relative flex-shrink-0 ${box} rounded-md border-2 flex items-center justify-center transition-all duration-200 outline-none focus-visible:ring-2 focus-visible:ring-[#0b57d0]/30 focus-visible:ring-offset-1 ${
          align === 'start' ? 'mt-0.5' : ''
        } ${
          isActive
            ? 'bg-[#0b57d0] border-[#0b57d0] shadow-sm'
            : `bg-white border-slate-300 ${!disabled ? 'group-hover:border-[#0b57d0] group-hover:bg-[#0b57d0]/5' : ''}`
        }`}
      >
        {indeterminate ? (
          <Minus size={icon} className="text-white" strokeWidth={3} />
        ) : checked ? (
          <Check size={icon} className="text-white animate-in zoom-in-50 duration-150" strokeWidth={3} />
        ) : null}
      </span>
      {(label || description) && (
        <span className="flex flex-col gap-0.5 select-none">
          {label && <span className={labelClassName}>{label}</span>}
          {description && (
            <span className="text-xs text-slate-500 leading-relaxed">{description}</span>
          )}
        </span>
      )}
    </label>
  );
};

export default Checkbox;
