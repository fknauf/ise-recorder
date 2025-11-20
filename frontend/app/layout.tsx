import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SpectrumProvider } from "./lib/SpectrumProvider";
import ServerEnvProvider from "./lib/ServerEnvProvider";
import { getServerEnv } from "./lib/ServerEnv";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ise-recorder",
  description: "Client-only lecture recorder",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  'use server';

  const env = await getServerEnv();

  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <SpectrumProvider>
          <ServerEnvProvider env={env}>
            {children}
          </ServerEnvProvider>
        </SpectrumProvider>
      </body>
    </html>
  );
}
