import GraphView from '../../GraphView';

export const dynamic = 'force-dynamic';

export default async function GatedDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ team?: string }>;
}) {
  const { key } = await params;
  const { team } = await searchParams;
  const expected = process.env.DASHBOARD_KEY;

  if (!expected || key !== expected) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0b0b12] text-zinc-400">
        <div className="text-center">
          <p className="text-lg font-semibold text-zinc-200">Access denied</p>
          <p className="mt-1 text-sm">
            This dashboard link is invalid or has expired.
          </p>
        </div>
      </div>
    );
  }

  if (!team) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#0b0b12] text-zinc-400">
        <div className="text-center">
          <p className="text-lg font-semibold text-zinc-200">No workspace selected</p>
          <p className="mt-1 text-sm">
            Append <code>?team=&lt;teamId&gt;</code> to this link, or pick one from{' '}
            <a className="underline" href="/workspaces">
              /workspaces
            </a>
            .
          </p>
        </div>
      </div>
    );
  }

  return <GraphView teamId={team} />;
}
