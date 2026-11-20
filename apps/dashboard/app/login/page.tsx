"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { accessToken, devMode, supabase } from "@/lib/api";
import { Button, Input } from "@/components/ui";

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void accessToken().then((t) => { if (t) router.replace("/"); }); }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const sb = supabase();
    if (!sb) { if (devMode) router.replace("/"); else setError("Supabase isn't configured for this dashboard yet."); return; }
    setBusy(true);
    setError(null);
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin, shouldCreateUser: true } });
    setBusy(false);
    if (error) setError(error.message); else setSent(true);
  }

  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="card fade-in w-full max-w-[380px] p-8">
        <div className="mb-6 grid h-10 w-10 place-items-center rounded-xl bg-ink text-bg font-semibold">A</div>
        <h1 className="text-[22px] font-semibold tracking-[-0.02em]">Sign in</h1>
        <p className="mt-1 text-[14px] text-muted">Your personal assistant's control room. Only the owner's account can get in.</p>
        {sent ? (
          <div className="mt-6 rounded-xl bg-ok-soft px-4 py-3 text-[14px] text-ok">Check {email} for a sign-in link.</div>
        ) : (
          <form onSubmit={submit} className="mt-6 space-y-3">
            <Input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            <Button className="w-full" disabled={busy}>{busy ? "Sending…" : "Email me a sign-in link"}</Button>
            {error && <p className="text-[13px] text-bad">{error}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
