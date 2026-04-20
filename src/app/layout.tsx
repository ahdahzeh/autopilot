import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Autopilot · Job Search Dashboard",
  description: "Track, visualize, and automate your job search pipeline",
  manifest: "/manifest.json",
};

// Runs before React hydrates. Applies the user's stored theme (or system
// preference) to <html> so the first paint matches, avoiding a dark/light
// flash on reload.
const NO_FLASH = `
(function(){try{
  var t=localStorage.getItem('theme');
  var sys=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
  var mode=t||sys;
  if(mode==='dark')document.documentElement.classList.add('dark');
}catch(e){}})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </head>
      <body className="min-h-full flex flex-col">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
