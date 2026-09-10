import type { Metadata } from 'next';
import Link from 'next/link';
import { appConfig } from '@/config/appConfig';
import PlatformState from '@/components/PlatformState';
import './globals.css';

export const metadata: Metadata = {
  title: 'Playwright Test Platform',
  description:
    'Author a test as data and steps in plain English, have an agent write the Playwright spec, and run it headless on the server.',
  // Inline so there is no favicon request to 404 in the console.
  icons: {
    icon:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%234c8dff'/%3E%3Cpath d='M12 9l8 7-8 7z' fill='%2306101f'/%3E%3C/svg%3E",
  },
};

/**
 * The shell every page renders inside.
 *
 * A server component: the environment name comes off the config layer directly,
 * with no round trip. The header's live parts — whether the agent tier answers
 * and where the platform is saving — are a client island, because both change
 * while the page is open.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app">
          <header className="topbar">
            <Link href="/" className="brand">
              Playwright Test Platform
            </Link>
            {appConfig.env !== 'local' && <span className="badge">{appConfig.env}</span>}
            <span className="spacer" />
            <PlatformState />
          </header>

          <main className="container">{children}</main>
        </div>
      </body>
    </html>
  );
}
