import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ApiClientError } from '@/api/client';
import { useCreateWebsite, useUpdateWebsite, useWebsite } from '@/api/hooks';
import { WebsiteForm, type WebsiteFormValues } from '@/components/website-form';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { useDocumentTitle } from '@/lib/use-document-title';

function Heading({ title, back }: { title: string; back: { to: string; label: string } }) {
  return (
    <div>
      <Link
        to={back.to}
        className="mb-2 inline-flex items-center gap-1 text-[13px] text-muted transition-colors hover:text-fg"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {back.label}
      </Link>
      <h1 className="text-xl font-semibold text-fg">{title}</h1>
    </div>
  );
}

export function AddWebsitePage() {
  useDocumentTitle('Add website · Beacon');
  const navigate = useNavigate();
  const create = useCreateWebsite();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Heading title="Add a website" back={{ to: '/websites', label: 'Websites' }} />
      <WebsiteForm
        submitLabel="Add website"
        pending={create.isPending}
        serverError={create.error}
        onCancel={() => void navigate('/websites')}
        onSubmit={(values: WebsiteFormValues) =>
          create.mutate(
            {
              ...values,
              recipients: values.recipients,
            },
            {
              onSuccess: (website) => {
                toast.success(`${website.name} added`);
                void navigate(`/websites/${website.id}`);
              },
            },
          )
        }
      />
    </div>
  );
}

export function EditWebsitePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const website = useWebsite(id);
  const update = useUpdateWebsite(id);
  useDocumentTitle(website.data ? `Edit ${website.data.name} · Beacon` : 'Edit website · Beacon');

  if (website.isPending) {
    return (
      <div className="mx-auto max-w-3xl space-y-4" aria-busy="true" aria-label="Loading website">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }
  if (website.isError) {
    return website.error instanceof ApiClientError && website.error.status === 404 ? (
      <EmptyState
        title="Website not found"
        description="It may have been removed, or the link may be wrong."
        action={
          <Link to="/websites" className={buttonVariants({ variant: 'primary' })}>
            Go to websites
          </Link>
        }
        className="mt-10"
      />
    ) : (
      <ErrorState
        title="Could not load this website"
        error={website.error}
        onRetry={() => void website.refetch()}
      />
    );
  }

  const data = website.data;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Heading title={`Edit ${data.name}`} back={{ to: `/websites/${id}`, label: data.name }} />
      <WebsiteForm
        website={data}
        submitLabel="Save changes"
        pending={update.isPending}
        serverError={update.error}
        onCancel={() => void navigate(`/websites/${id}`)}
        onSubmit={({ recipients: _recipients, ...values }) =>
          update.mutate(values, {
            onSuccess: () => {
              toast.success('Changes saved');
              void navigate(`/websites/${id}`);
            },
          })
        }
      />
    </div>
  );
}
