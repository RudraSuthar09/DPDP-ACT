import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DPDP Compliance Platform',
  description: 'Compliance operating system for India’s DPDP Act — Stage 1.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
