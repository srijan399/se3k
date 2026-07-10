import { cookies } from 'next/headers';
import GraphView from '../../components/GraphView';
import { decodeSession, SESSION_COOKIE } from '../lib/session';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const cookieStore = await cookies();
  const session = decodeSession(cookieStore.get(SESSION_COOKIE)?.value);

  if (!session) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#26082A] text-[#D8C6DB]">
        <div className="text-center">
          <p className="text-lg font-semibold text-white">Sign-in required</p>
          <p className="mt-1 text-sm">
            <a className="underline text-[#36C5F0]" href="/workspaces">
              Add SE3K to Slack
            </a>{' '}
            to view your workspace&apos;s graph.
          </p>
        </div>
      </div>
    );
  }

  return <GraphView teamId={session.teamId} />;
}
