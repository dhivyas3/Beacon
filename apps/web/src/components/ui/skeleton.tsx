import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** A placeholder with the size of the thing it stands for, so nothing shifts when data arrives. */
export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-md bg-surface-2', className)}
      {...props}
    />
  );
}
