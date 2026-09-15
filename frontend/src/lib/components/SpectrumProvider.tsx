"use client";

import { Provider } from "@react-spectrum/s2/Provider";
import { useRouter } from "next/navigation";

// Configure the type of the `routerOptions` prop on all React Spectrum components.
declare module "@react-spectrum/s2/Provider" {
  interface RouterConfig {
    routerOptions: NonNullable<Parameters<ReturnType<typeof useRouter>["push"]>[1]>
  }
}

export function SpectrumProvider(
  { locale, children }: Readonly<{ locale: string; children?: React.ReactNode }>
) {
  const router = useRouter();

  return (
    <Provider
      locale={locale}
      router={{ navigate: router.push }}
    >
      {children}
    </Provider>
  );
}
