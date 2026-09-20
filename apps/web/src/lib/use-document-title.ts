import { useEffect } from 'react';

/** Sets the browser tab title for as long as the component is mounted. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);
}
