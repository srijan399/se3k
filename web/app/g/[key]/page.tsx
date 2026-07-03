import GraphView from '../../GraphView';

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
          <p className="mt-1 text-sm">
            This dashboard link is invalid or has expired.
          </p>
        </div>
      </div>
    );
  }

  return <GraphView />;
}
