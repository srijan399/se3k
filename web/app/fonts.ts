import { Inter, IBM_Plex_Mono } from 'next/font/google';

export const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-landing-sans',
});

export const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-landing-mono',
});

export const sans = 'var(--font-landing-sans), system-ui, sans-serif';
export const mono = 'var(--font-landing-mono), ui-monospace, monospace';
