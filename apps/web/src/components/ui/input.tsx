import { ChevronDown } from 'lucide-react';
import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

const fieldBase =
  'w-full rounded-md border border-border-strong bg-surface text-sm text-fg shadow-card transition-colors duration-150 placeholder:text-subtle hover:border-subtle focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-critical';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(fieldBase, 'h-9 px-3', className)} {...props} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea ref={ref} className={cn(fieldBase, 'min-h-20 px-3 py-2', className)} {...props} />
  );
});

/** A native select, styled. Native keeps it fully keyboard and screen reader accessible. */
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <div className="relative inline-block">
        <select
          ref={ref}
          className={cn(fieldBase, 'h-9 appearance-none pl-3 pr-8', className)}
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle"
          aria-hidden
        />
      </div>
    );
  },
);

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-[13px] font-medium text-fg', className)} {...props} />;
}

export function FieldHint({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <p id={id} className="mt-1.5 text-[13px] text-muted">
      {children}
    </p>
  );
}

export function FieldError({ children, id }: { children: React.ReactNode; id?: string }) {
  return (
    <p id={id} role="alert" className="mt-1.5 text-[13px] text-critical-text">
      {children}
    </p>
  );
}
