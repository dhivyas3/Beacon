import { Compass } from 'lucide-react';
import { Link } from 'react-router';
import { buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/states';
import { useDocumentTitle } from '@/lib/use-document-title';

export function NotFoundPage() {
  useDocumentTitle('Page not found · Beacon');
  return (
    <EmptyState
      icon={Compass}
      title="This page does not exist"
      description="The address may be mistyped, or the page may have moved."
      action={
        <Link to="/" className={buttonVariants({ variant: 'primary' })}>
          Go to scans
        </Link>
      }
      className="mt-10"
    />
  );
}
