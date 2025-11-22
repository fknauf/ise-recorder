'use client';

import {defaultTheme, Provider} from '@adobe/react-spectrum';
import {useRouter} from 'next/navigation';

declare module '@adobe/react-spectrum' {
  interface RouterConfig {
    routerOptions: NonNullable<
      Parameters<ReturnType<typeof useRouter>['push']>[1]
    >;
  }
}

export function SpectrumProvider(
  { children }: Readonly<{children: React.ReactNode}>
) {
  const router = useRouter();

  return (
    <Provider
      theme={defaultTheme}
      defaultColorScheme='dark'
      locale='en-US'
      router={{ navigate: router.push }
    }>
      {children}
    </Provider>
  );
}
