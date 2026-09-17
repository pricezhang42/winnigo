import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Winnigo — Find your Winnipeg",
  description: "Discover events, places, and things to do in Winnipeg. Local sources. One place to look.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
