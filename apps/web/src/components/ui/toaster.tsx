import { Toaster as Sonner } from 'sonner';
import { useTheme } from '@/lib/theme';

/** Toasts for confirmations. Styled with the app tokens so they follow light and dark. */
export function Toaster() {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast:
            '!rounded-lg !border !border-border !bg-surface !text-fg !shadow-pop !text-[13px] !font-sans',
          description: '!text-muted',
        },
      }}
    />
  );
}
