"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { accessToken, devMode, supabase } from "@/lib/api";
import { cx } from "./ui";

const NAV = [
  { href: "/", label: "Overview", icon: "M3 12l9-8 9 8M5 10v10h14V10" },
  { href: "/assistant", label: "My Assistant", icon: "M12 3a4 4 0 110 8 4 4 0 010-8zM4 21a8 8 0 0116 0" },
  { href: "/phone", label: "Phone", icon: "M5 4h4l2 5-3 2a11 11 0 005 5l2-3 5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2" },
  { href: "/connections", label: "Connections", icon: "M10 14a4 4 0 005.6 0l3-3a4 4 0 00-5.6-5.6l-1 1M14 10a4 4 0 00-5.6 0l-3 3a4 4 0 005.6 5.6l1-1" },
  { href: "/memory", label: "Memory", icon: "M12 4c4 0 7 2 7 5s-3 5-7 5-7-2-7-5 3-5 7-5zM5 9v6c0 3 3 5 7 5s7-2 7-5V9" },
  { href: "/tasks", label: "Tasks", icon: "M9 11l3 3 8-8M20 12v7a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2h9" },
  { href: "/calls", label: "Call History", icon: "M12 8v4l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
  { href: "/usage", label: "Usage & Costs", icon: "M4 20V10M10 20V4M16 20v-7M22 20H2" },
  { href: "/settings", label: "Settings", icon: "M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" },
];

function Icon({ d }: { d: string }) {
  return <svg viewBox="0 0 24 24" className="h-[17px] w-[17px] shrink-0" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
}

export function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const isLogin = pathname === "/login";

  useEffect(() => {
    if (isLogin) { setReady(true); return; }
    let cancelled = false;
    (async () => {
      const token = await accessToken();
      if (cancelled) return;
      if (!token) { router.replace("/login"); return; }
      const sb = supabase();
      if (sb) setEmail((await sb.auth.getUser()).data.user?.email ?? null);
      else if (devMode) setEmail("local development");
      setReady(true);
    })();
    const sub = supabase()?.auth.onAuthStateChange((evt) => { if (evt === "SIGNED_OUT") router.replace("/login"); });
    return () => { cancelled = true; sub?.data.subscription.unsubscribe(); };
  }, [isLogin, router]);

  useEffect(() => setOpen(false), [pathname]);

  if (isLogin) return <>{children}</>;
  if (!ready) return <div className="grid min-h-screen place-items-center text-[13px] text-muted">Loading…</div>;

  const nav = (
    <nav className="flex flex-col gap-0.5">
      {NAV.map((n) => {
        const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
        return (
          <Link key={n.href} href={n.href} className={cx("flex items-center gap-3 rounded-lg px-3 py-2 text-[14px] transition", active ? "bg-surface text-ink shadow-[var(--shadow)] font-medium" : "text-muted hover:text-ink hover:bg-surface-2")}>
            <Icon d={n.icon} />{n.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="min-h-screen md:grid md:grid-cols-[248px_1fr]">
      <aside className="hidden md:flex sticky top-0 h-screen flex-col justify-between border-r border-line px-4 py-6">
        <div>
          <Brand />
          <div className="mt-8">{nav}</div>
        </div>
        <Account email={email} />
      </aside>
      <header className="md:hidden sticky top-0 z-20 flex items-center justify-between border-b border-line bg-bg/90 px-4 py-3 backdrop-blur">
        <Brand />
        <button aria-label="Menu" onClick={() => setOpen(!open)} className="rounded-lg p-2 hover:bg-surface-2"><Icon d="M4 7h16M4 12h16M4 17h16" /></button>
      </header>
      {open && <div className="md:hidden border-b border-line bg-bg px-4 pb-4">{nav}<div className="mt-4"><Account email={email} /></div></div>}
      <main className="mx-auto w-full max-w-[1120px] px-4 py-8 md:px-10 md:py-12">{children}</main>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <div className="grid h-7 w-7 place-items-center rounded-lg bg-ink text-bg text-[13px] font-semibold">A</div>
      <div className="text-[15px] font-semibold tracking-[-0.01em]">Personal Assistant</div>
    </div>
  );
}

function Account({ email }: { email: string | null }) {
  const router = useRouter();
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg px-2 py-2">
      <div className="min-w-0 truncate text-[12.5px] text-muted">{email}</div>
      {supabase() && (
        <button className="text-[12.5px] text-muted hover:text-ink" onClick={async () => { await supabase()!.auth.signOut(); router.replace("/login"); }}>
          Sign out
        </button>
      )}
    </div>
  );
}
