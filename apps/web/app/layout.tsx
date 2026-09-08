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
      "Hookemon buys gacha card packs, opens them, sells the cards and pays the proceeds to HKMN holders. Trading fees fund the packs.",
    icons: {
      icon: [{ url: "/hookemon-mark.png", type: "image/png" }],
      apple: "/hookemon-mark.png",
    },
    openGraph: {
      title: "Hookemon: The cycle never stops.",
      description: "We open Collector Crypt gacha packs, sell the cards and share the proceeds with HKMN holders.",
      type: "website",
      siteName: "Hookemon",
      images: [
        {
          url: "/hookemon-robinhood-share.png",
          width: 1270,
          height: 711,
          alt: "Hookemon on Robinhood Chain above a mountain landscape",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "Hookemon: The cycle never stops.",
      description: "We open Collector Crypt gacha packs, sell the cards and share the proceeds with HKMN holders.",
      images: ["/hookemon-robinhood-share.png"],
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
