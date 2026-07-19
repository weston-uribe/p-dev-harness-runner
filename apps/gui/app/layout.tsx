import { Inter } from "next/font/google";

import { ThemeProvider } from "@/components/custom/theme-provider";
import "@/styles/globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata = {
  title: "Product Development Harness",
  description: "Local operator GUI for harness setup and configuration.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body data-p-dev-runtime-smoke="1">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
