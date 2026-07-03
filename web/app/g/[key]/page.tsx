import GraphView from '../../GraphView';

// Shareable, key-gated dashboard: /g/<DASHBOARD_KEY> shows the workspace graph.
// The unguessable key is the capability (hackathon shortcut: the key IS the auth
// — would gate behind Slack OAuth per workspace before any production use).
// The bot hands out this link via /se3k-dashboard.
export const dynamic = 'force-dynamic';

export default async function GatedDashboard({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const expected = process.env.DASHBOARD_KEY;

  if (!expected || key !== expected) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0b0b12] text-zinc-400">
        <div className="text-center">
          <p className="text-lg font-semibold text-zinc-200">Access denied</p>
          <p className="mt-1 text-sm">This dashboard link is invalid or has expired.</p>
        </div>
      </div>
    );
  }

  return <GraphView />;
}
