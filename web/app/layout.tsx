import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "K-Stock 한국주식 자동매매",
  description: "키움증권과 한국투자증권을 함께 운용하는 한국주식 자동매매 프로그램",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
