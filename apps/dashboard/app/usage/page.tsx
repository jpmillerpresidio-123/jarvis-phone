"use client";
import { compact, usd } from "@/lib/api";
import { useApi } from "@/lib/useApi";
import { Card, Notice, PageHeader, Row, Skeleton, Stat } from "@/components/ui";

interface Usage {
  tokens: { input: number; output: number; cacheRead: number }; twilioMinutes: number;
  costs: { claudeUsd: number; twilioUsd: number; hostingUsd: number; numberUsd: number };
  monthToDateUsd: number; projectedMonthUsd: number; budgetUsd: number; daily: { day: string; claudeUsd: number; twilioUsd: number }[]; model: string;
}

export default function UsagePage() {
  const { data: u, error } = useApi<Usage>("/api/usage");
  const max = Math.max(0.01, ...(u?.daily.map((d) => d.claudeUsd + d.twilioUsd) ?? [0]));
  return (
    <>
      <PageHeader title="Usage & Costs" subtitle="This month so far. Prices are estimates from list rates and are recorded per call." />
      {error && <Notice tone="bad">{error}</Notice>}
      {u && u.projectedMonthUsd > u.budgetUsd && <Notice tone="warn">At this pace you'll spend about {usd(u.projectedMonthUsd)} this month, over your {usd(u.budgetUsd)} budget. Change the budget in Settings.</Notice>}
      {!u ? <Skeleton className="h-72" /> : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Month to date" value={usd(u.monthToDateUsd + u.costs.hostingUsd + u.costs.numberUsd)} sub="Including fixed costs" />
            <Stat label="Projected month" value={usd(u.projectedMonthUsd)} sub={`Budget ${usd(u.budgetUsd)}`} />
            <Stat label="Claude tokens" value={compact(u.tokens.input + u.tokens.output + u.tokens.cacheRead)} sub={`${compact(u.tokens.output)} output`} />
            <Stat label="Twilio minutes" value={u.twilioMinutes} sub={usd(u.costs.twilioUsd)} />
          </div>
          <Card title="Daily spend">
            {u.daily.length === 0 ? <p className="text-[13px] text-muted">No usage yet this month.</p> : (
              <div className="flex h-40 items-end gap-1.5" role="img" aria-label="Daily spend chart">
                {u.daily.map((d) => {
                  const total = d.claudeUsd + d.twilioUsd;
                  return (
                    <div key={d.day} className="group flex flex-1 flex-col items-center justify-end" title={`${d.day}: ${usd(total)} (Claude ${usd(d.claudeUsd)}, Twilio ${usd(d.twilioUsd)})`}>
                      <div className="w-full max-w-[28px] rounded-t-[4px] bg-accent/80 transition group-hover:bg-accent" style={{ height: `${Math.max(3, (total / max) * 100)}%` }} />
                      <div className="mt-1.5 text-[10.5px] text-faint">{Number(d.day.slice(8))}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
          <Card title="Breakdown">
            <Row label="Claude API" hint={`Model ${u.model} · ${compact(u.tokens.input)} in / ${compact(u.tokens.output)} out / ${compact(u.tokens.cacheRead)} cached`}><span className="tabular-nums">{usd(u.costs.claudeUsd)}</span></Row>
            <Row label="Twilio voice + ConversationRelay" hint="About $0.08 per minute"><span className="tabular-nums">{usd(u.costs.twilioUsd)}</span></Row>
            <Row label="Twilio phone number" hint="Monthly"><span className="tabular-nums">{usd(u.costs.numberUsd)}</span></Row>
            <Row label="Hosting (Railway)" hint="Estimate. Set HOSTING_MONTHLY_USD to match your plan. Vercel Hobby and Supabase Free are $0."><span className="tabular-nums">{usd(u.costs.hostingUsd)}</span></Row>
          </Card>
        </div>
      )}
    </>
  );
}
