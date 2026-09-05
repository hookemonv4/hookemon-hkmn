import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { resolveMetadataBase } from "../lib/metadata";
import "./globals.css";
import "./hoenn-theme.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const metadataBase = resolveMetadataBase(host, requestHeaders.get("x-forwarded-proto"));

  return {
    metadataBase,
    title: "Hookemon: The cycle never stops.",
    description:
      "A Pikachu-guided open-source Uniswap v4 prototype that turns swap activity into digital card packs and automatic USDC holder rewards.",
    icons: {
      icon: [{ url: "/hookemon-mark.png", type: "image/png" }],
      apple: "/hookemon-mark.png",
    },
    openGraph: {
      title: "Hookemon: The cycle never stops.",
      description: "Follow the 3% swap loop from Ethereum to packs and automatic USDC rewards.",
      type: "website",
      siteName: "Hookemon",
      images: [
        {
          url: "/hookemon-banner.jpeg",
          width: 1500,
          height: 500,
          alt: "Hookemon. Swaps rip packs, hits pay holders.",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Hookemon: The cycle never stops.",
      description: "Follow the 3% swap loop from Ethereum to packs and automatic USDC rewards.",
      images: ["/hookemon-banner.jpeg"],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
