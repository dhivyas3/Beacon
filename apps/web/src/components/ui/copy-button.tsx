import { Check, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from './button';

/** Copies text to the clipboard and confirms it, with a toast and a check mark. */
export function CopyButton({
  value,
  label = 'Copy',
  successMessage = 'Copied to clipboard',
  variant = 'secondary',
  size = 'sm',
  iconOnly = false,
}: {
  value: string;
  label?: string;
  successMessage?: string;
  variant?: 'secondary' | 'ghost' | 'primary';
  size?: 'sm' | 'md';
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(successMessage);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('Could not copy. Select the text and copy it by hand.');
    }
  }

  const Icon = copied ? Check : Copy;
  return (
    <Button
      variant={variant}
      size={iconOnly ? (size === 'sm' ? 'icon-sm' : 'icon') : size}
      onClick={() => void copy()}
      aria-label={iconOnly ? label : undefined}
    >
      <Icon className="size-3.5" aria-hidden />
      {iconOnly ? null : copied ? 'Copied' : label}
    </Button>
  );
}
