'use client';

import { useC2cApi } from '../../hooks/useC2cApi';

function StatusPill({ label, live }: { label: string; live: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-slate-200 bg-white/80 px-4 py-3 shadow-sm">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      <span
        className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${
          live ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
        }`}
      >
        {live ? 'live' : 'unreachable'}
      </span>
    </div>
  );
}

export function StudioShell() {
  const { health, mode, error, errorKind, loading } = useC2cApi();

  const upstreamIssues = mode
    ? [
        mode.orchestrator !== 'live' ? 'Orchestrator is not reachable.' : null,
        mode.evidence !== 'live' ? 'Evidence service is not reachable.' : null,
      ].filter((issue): issue is string => issue !== null)
    : [];

  const canTransform =
    health?.status === 'ok' && !error && upstreamIssues.length === 0 && errorKind === null;

  const backendStateLabel = loading
    ? 'checking'
    : health?.status !== 'ok' || error
      ? 'blocked'
      : upstreamIssues.length > 0
        ? 'degraded'
        : 'connected';

  const blockingTitle =
    errorKind === 'config'
      ? 'Configuration Error'
      : errorKind === 'parse' || errorKind === 'contract'
        ? 'Contract Error'
        : 'Backend Unavailable';

  const blockingMessage =
    errorKind === 'config'
      ? 'Studio runtime configuration is invalid. Fix the BFF base URL override before using the product.'
      : errorKind === 'parse' || errorKind === 'contract'
        ? 'The BFF returned data that does not match the expected frontend contract.'
        : 'Studio cannot reach the backend right now. Transformation actions remain disabled.';

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(15,118,110,0.16),_transparent_45%),linear-gradient(180deg,_#f8fafc_0%,_#ecfeff_100%)] text-slate-950">
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-6 py-8">
        <section className="overflow-hidden rounded-[28px] border border-slate-200/70 bg-slate-950 text-white shadow-2xl shadow-slate-900/10">
          <div className="flex flex-col gap-6 px-8 py-10">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm uppercase tracking-[0.3em] text-teal-300">c2c</p>
                <h1 className="mt-2 text-4xl font-semibold tracking-tight">Transformation Studio</h1>
                <p className="mt-3 max-w-2xl text-sm text-slate-300">
                  Next.js Studio shell backed only by the c2c BFF. Product actions stay fail-closed
                  until health, mode, and contract checks all pass.
                </p>
              </div>
              <div className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm text-slate-200">
                Backend: {backendStateLabel}
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Readiness</p>
                <p className="mt-3 text-2xl font-semibold">
                  {canTransform ? 'Ready for product-mode transforms' : 'Blocked until dependencies recover'}
                </p>
                <p className="mt-2 text-sm text-slate-300">
                  Transformation actions are enabled only when the BFF is healthy and both required upstreams are live.
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <p className="text-xs uppercase tracking-[0.25em] text-slate-400">Primary Action</p>
                <button
                  type="button"
                  disabled={!canTransform}
                  className="mt-3 inline-flex cursor-not-allowed items-center rounded-full bg-teal-400 px-5 py-3 text-sm font-semibold text-slate-950 disabled:opacity-50"
                >
                  Start Transformation
                </button>
                <p className="mt-2 text-sm text-slate-300">
                  This shell intentionally blocks actions when backend health, upstream reachability, or payload contracts fail.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[24px] border border-slate-200 bg-white/85 p-6 shadow-lg shadow-slate-200/60">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold">Backend Status</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Honest startup state for BFF health, upstream mode, and runtime contract validation.
                </p>
              </div>
              {loading && (
                <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
                  Loading
                </span>
              )}
            </div>

            <div className="mt-6 grid gap-3">
              <StatusPill label="BFF health" live={health?.status === 'ok'} />
              <StatusPill label="Orchestrator reachability" live={mode?.orchestrator === 'live'} />
              <StatusPill label="Evidence reachability" live={mode?.evidence === 'live'} />
            </div>

            {error && (
              <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-5 text-rose-950">
                <h3 className="text-sm font-semibold uppercase tracking-wide">{blockingTitle}</h3>
                <p className="mt-2 text-sm">{blockingMessage}</p>
                <p className="mt-3 rounded-lg bg-white/70 px-3 py-2 font-mono text-xs">{error}</p>
              </div>
            )}

            {!error && upstreamIssues.length > 0 && (
              <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-950">
                <h3 className="text-sm font-semibold uppercase tracking-wide">Upstream Constraints</h3>
                <ul className="mt-2 space-y-2 text-sm">
                  {upstreamIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          <aside className="rounded-[24px] border border-slate-200 bg-white/85 p-6 shadow-lg shadow-slate-200/60">
            <h2 className="text-xl font-semibold">BFF Mode Contract</h2>
            <p className="mt-1 text-sm text-slate-600">
              Known fields are typed explicitly; unknown fields remain visible for inspection.
            </p>
            <pre className="mt-5 overflow-auto rounded-2xl bg-slate-950 p-4 text-xs text-slate-100">
              {JSON.stringify(mode ?? { orchestrator: 'unknown', evidence: 'unknown' }, null, 2)}
            </pre>
          </aside>
        </section>
      </main>
    </div>
  );
}
