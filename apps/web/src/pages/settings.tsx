import { BookOpen } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useState } from 'react';
import { useSession } from '@/api/hooks';
import { ApiKeysSection } from '@/components/settings/api-keys';
import { DefaultsSection } from '@/components/settings/defaults';
import { DomainsSection } from '@/components/settings/domains';
import { WebhooksSection } from '@/components/settings/webhooks';
import { buttonVariants } from '@/components/ui/button';
import { Alert } from '@/components/ui/states';
import { cn } from '@/lib/cn';
import { useDocumentTitle } from '@/lib/use-document-title';

const TABS = [
  { value: 'keys', label: 'API keys', admin: true },
  { value: 'domains', label: 'Allowed domains', admin: true },
  { value: 'webhooks', label: 'Webhooks', admin: true },
  { value: 'defaults', label: 'Scan defaults', admin: false },
] as const;

export function SettingsPage() {
  useDocumentTitle('Settings · QA Hub');
  const session = useSession();
  const isAdmin = session.data?.user.role === 'admin';
  const [tab, setTab] = useState<(typeof TABS)[number]['value']>(isAdmin ? 'keys' : 'defaults');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-fg">Settings</h1>
          <p className="mt-1 text-[13px] text-muted">
            Keys, allowed sites, callbacks and scan defaults.
          </p>
        </div>
        <a
          href="/api/docs"
          target="_blank"
          rel="noreferrer noopener"
          className={buttonVariants({ variant: 'secondary', size: 'sm' })}
        >
          <BookOpen className="size-3.5" aria-hidden />
          API documentation
        </a>
      </div>

      {!isAdmin ? (
        <Alert tone="info" title="Some settings are for admins">
          You can view the scan defaults. Ask an admin to manage API keys, allowed domains and
          webhooks.
        </Alert>
      ) : null}

      <Tabs.Root value={tab} onValueChange={(value) => setTab(value as typeof tab)}>
        <Tabs.List
          aria-label="Settings sections"
          className="scroll-x mb-5 flex gap-1 border-b border-border"
        >
          {TABS.filter((entry) => isAdmin || !entry.admin).map((entry) => (
            <Tabs.Trigger
              key={entry.value}
              value={entry.value}
              className={cn(
                '-mb-px whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted transition-colors duration-150 hover:text-fg',
                'data-[state=active]:border-accent data-[state=active]:text-fg',
              )}
            >
              {entry.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {isAdmin ? (
          <>
            <Tabs.Content value="keys">
              <ApiKeysSection />
            </Tabs.Content>
            <Tabs.Content value="domains">
              <DomainsSection />
            </Tabs.Content>
            <Tabs.Content value="webhooks">
              <WebhooksSection />
            </Tabs.Content>
          </>
        ) : null}
        <Tabs.Content value="defaults">
          <DefaultsSection canEdit={isAdmin} />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}
