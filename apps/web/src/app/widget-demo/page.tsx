'use client';

import { useEffect } from 'react';

/** A host page for trying the embeddable widget during development. */
export default function WidgetDemoPage() {
  useEffect(() => {
    const script = document.createElement('script');
    script.src = '/widget.js';
    script.defer = true;
    script.dataset.api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
    script.dataset.title = 'Chat with support';
    script.dataset.greeting = 'Hello! Ask us anything about your account.';
    document.body.appendChild(script);
    return () => {
      script.remove();
      document.querySelector('.atr-root')?.remove();
    };
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold">Widget preview</h1>
      <p className="mt-2 text-sm text-text-muted">
        This page embeds the customer chat widget exactly as a customer&apos;s own website would.
        Open it with the button in the corner.
      </p>
      <pre className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface p-4 text-xs">
        {`<script src="https://app.example.com/widget.js"
        data-api="https://api.example.com"
        data-key="wk_your_widget_key"
        data-title="Chat with us"
        data-accent="#2563eb"
        defer></script>`}
      </pre>
    </main>
  );
}
