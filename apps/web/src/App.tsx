import { CHECK_LABELS, CHECK_TYPES } from '@qa-hub/shared';

export function App() {
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">QA Hub</h1>
      <p className="mt-2 text-neutral-600">
        Checks available: {CHECK_TYPES.map((type) => CHECK_LABELS[type]).join(', ')}.
      </p>
    </main>
  );
}
