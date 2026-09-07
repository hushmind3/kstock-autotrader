"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, AlertTriangle, ClipboardList, LayoutDashboard, Settings, TrendingUp, WalletCards } from "lucide-react";
import type { ReactNode } from "react";

const navigation = [
  { href: "/", label: "현물 자동매매", mobileLabel: "현물", icon: LayoutDashboard },
  { href: "/derivatives", label: "선물·옵션 자동매매", mobileLabel: "선물", icon: TrendingUp },
  { href: "/derivatives/settings", label: "선물·옵션 자동매매 설정", mobileLabel: "선물설정", icon: Settings },
  { href: "/orders", label: "현물 주문·체결", mobileLabel: "주문", icon: ClipboardList },
  { href: "/positions", label: "현물 보유종목", mobileLabel: "보유", icon: WalletCards },
  { href: "/errors", label: "시스템 기록", mobileLabel: "기록", icon: AlertTriangle },
  { href: "/settings", label: "현물 자동매매 설정", mobileLabel: "설정", icon: Settings },
];

export function activeNavigationHref(pathname: string): string | null {
  return navigation
    .filter(({ href }) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`)))
    .sort((left, right) => right.href.length - left.href.length)[0]?.href ?? null;
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const activeHref = activeNavigationHref(pathname);
  return (
    <div className="app-frame">
      <aside className="sidebar">
        <Link className="brand" href="/" aria-label="한국주식 자동매매 홈">
          <span className="brand-mark"><Activity size={17} /></span>
          <span><strong>K-STOCK</strong><small>한국주식 자동매매</small></span>
        </Link>
        <nav aria-label="주요 메뉴">
          {navigation.map(({ href, label, mobileLabel, icon: Icon }) => {
            const active = activeHref === href;
            return <Link key={href} aria-label={label} aria-current={active ? "page" : undefined} title={label} className={active ? "active" : ""} href={href}><Icon size={17} /><span>{label}</span><small>{mobileLabel}</small></Link>;
          })}
        </nav>
        <div className="sidebar-note"><span>PC · 클라우드 공용</span><p>같은 프로그램을 이 PC 또는 리눅스 서버에서 실행할 수 있습니다.</p></div>
      </aside>
      <div className="content-frame">{children}</div>
    </div>
  );
}
