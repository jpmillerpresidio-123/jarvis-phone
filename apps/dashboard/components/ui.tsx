"use client";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function cx(...c: (string | false | null | undefined)[]) { return c.filter(Boolean).join(" "); }

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{title}</h1>
        {subtitle && <p className="mt-1 text-[14px] text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({ children, className, title, action }: { children: ReactNode; className?: string; title?: string; action?: ReactNode }) {
  return (
    <section className={cx("card fade-in p-5", className)}>
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between gap-3">
          {title && <h2 className="text-[13px] font-medium uppercase tracking-[0.06em] text-muted">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

const tones = {
  ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad",
  info: "bg-accent-soft text-accent", neutral: "bg-surface-2 text-muted",
} as const;
export function Badge({ tone = "neutral", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={cx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-medium whitespace-nowrap", tones[tone])}>{children}</span>;
}
export function Dot({ tone }: { tone: keyof typeof tones }) {
  const c = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad", info: "bg-accent", neutral: "bg-faint" }[tone];
  return <span className={cx("inline-block h-2 w-2 rounded-full", c)} />;
}

export function Button({ variant = "primary", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  const v = {
    primary: "bg-ink text-bg hover:opacity-90",
    secondary: "bg-surface border border-line hover:bg-surface-2",
    ghost: "text-muted hover:text-ink hover:bg-surface-2",
    danger: "text-bad hover:bg-bad-soft",
  }[variant];
  return <button {...p} className={cx("inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3.5 text-[13.5px] font-medium transition disabled:opacity-40 disabled:pointer-events-none", v, className)} />;
}

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx("h-9 w-full rounded-lg border border-line bg-surface px-3 text-[14px] outline-none placeholder:text-faint focus:border-accent", p.className)} />;
}
export function Textarea(p: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx("w-full rounded-lg border border-line bg-surface px-3 py-2 text-[14px] leading-relaxed outline-none placeholder:text-faint focus:border-accent", p.className)} />;
}
export function Select({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 rounded-lg border border-line bg-surface px-2.5 text-[14px] outline-none focus:border-accent">
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={cx("relative h-[22px] w-[38px] shrink-0 rounded-full transition", checked ? "bg-accent" : "bg-line")}>
      <span className={cx("absolute top-[3px] h-4 w-4 rounded-full bg-white shadow transition-all", checked ? "left-[19px]" : "left-[3px]")} />
    </button>
  );
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[12.5px] text-muted">{hint}</span>}
    </label>
  );
}
export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-3.5 last:border-0">
      <div><div className="text-[14px]">{label}</div>{hint && <div className="text-[12.5px] text-muted">{hint}</div>}</div>
      {children}
    </div>
  );
}
export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="card fade-in p-5">
      <div className="text-[12.5px] text-muted">{label}</div>
      <div className="mt-1.5 text-[26px] font-semibold tracking-[-0.02em] tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-[12.5px] text-muted">{sub}</div>}
    </div>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-10 text-center">
      <div className="text-[14px] font-medium">{title}</div>
      {children && <div className="mx-auto mt-1 max-w-sm text-[13px] text-muted">{children}</div>}
    </div>
  );
}
export function Notice({ tone = "info", children }: { tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode }) {
  const t = { info: "bg-accent-soft text-accent", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad", ok: "bg-ok-soft text-ok" }[tone];
  return <div className={cx("fade-in mb-6 rounded-xl px-4 py-3 text-[13.5px]", t)}>{children}</div>;
}
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-lg bg-surface-2", className)} />;
}

export const statusTone = (s: string): keyof typeof tones =>
  ({ connected: "ok", completed: "ok", in_progress: "info", running: "info", untested: "neutral", pending_confirmation: "warn", needs_auth: "warn", cancelled: "neutral", error: "bad", failed: "bad", blocked: "bad", rejected: "neutral", disconnected: "neutral" } as Record<string, keyof typeof tones>)[s] ?? "neutral";
export const statusLabel = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
