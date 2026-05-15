import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'c2c Transformation Studio',
  description: 'c2c Transformation Studio',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}