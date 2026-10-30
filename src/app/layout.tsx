import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'FairShare — Shared expenses, made fair',
  description: 'Manage group expenses, split bills, and settle up with confidence.',
  icons: { icon: '/icon.svg' },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
