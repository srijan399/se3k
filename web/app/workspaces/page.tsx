import WorkspacesClient from './WorkspacesClient';

export const dynamic = 'force-dynamic';

export default function WorkspacesPage() {
  const dashboardKey = process.env.DASHBOARD_KEY || null;
  return <WorkspacesClient dashboardKey={dashboardKey} />;
}
