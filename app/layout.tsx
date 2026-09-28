import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'صيدلية حياة المجد | متجر العناية',
  description: 'متجر عربي لمنتجات العناية بالبشرة والشعر بمنتجات أصلية وتوصيل سريع.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ar" dir="rtl"><body>{children}</body></html>;
}
