import '@/styles/globals.css';

import type { AppProps } from 'next/app';
import type { Session } from 'next-auth';
import { SessionProvider } from 'next-auth/react';

function MyApp({ Component, pageProps: { session, ...pageProps } }: AppProps<{ session: Session }>) {
  return (
    <SessionProvider session={session} basePath='/control/api/auth'>
      <Component {...pageProps} />
    </SessionProvider>
  );
}

export default MyApp;
