import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  const socialImage = new URL("/og.png", metadataBase).toString();

  return {
    metadataBase,
    title: "CanvasRoom — your ideas, in motion",
    description: "A local-first connected whiteboard for natural iPad drawing, rich media, and beautifully composed recordings.",
    applicationName: "CanvasRoom",
    manifest: "/manifest.webmanifest",
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: "CanvasRoom",
    },
    openGraph: {
      type: "website",
      title: "CanvasRoom",
      description: "Your ideas, in motion. Draw from iPad, add media, and record the whole story.",
      images: [{ url: socialImage, width: 1730, height: 909, alt: "CanvasRoom connected whiteboard" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "CanvasRoom",
      description: "Your ideas, in motion.",
      images: [socialImage],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
