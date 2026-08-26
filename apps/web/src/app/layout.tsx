import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import '../styles/globals.css';

export const metadata: Metadata = {
  title: 'Atrrehub',
  description: 'AI-native omnichannel customer experience and contact center platform',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
