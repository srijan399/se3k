import { cookies } from 'next/headers';
import WorkspacesClient from './WorkspacesClient';
import AddToSlackButton from '../../components/AddToSlackButton';
import { decodeSession, SESSION_COOKIE } from '../lib/session';

export const dynamic = 'force-dynamic';

export default async function WorkspacesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const cookieStore = await cookies();
  const session = decodeSession(cookieStore.get(SESSION_COOKIE)?.value);
  const { error } = await searchParams;

  if (!session) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#26082A] text-[#D8C6DB]">
        <div className="flex flex-col items-center gap-4 text-center">
          <p className="text-lg font-semibold text-white">
            Add SE3K to a workspace to get started
          </p>
          {error && (
            <p className="text-sm text-[#E01E5A]">Install failed: {error}</p>
          )}
          <p className="max-w-sm text-sm">
            Whoever installs it is signed in automatically — no separate
            login step.
          </p>
          <AddToSlackButton />
        </div>
      </div>
    );
  }

  return <WorkspacesClient session={session} />;
}
