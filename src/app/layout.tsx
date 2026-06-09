import type { Metadata } from "next";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: "套房租金管理系統",
  description: "電腦版套房租金後台管理 MVP"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

