import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'Reflow — payment recovery agent',
  description:
    'Watches failed payments, diagnoses why each failed, picks the cheapest intervention likely to work, executes inside hard guardrails, and reports measured recovery against a baseline.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground">{children}</body>
    </html>
  );
}
