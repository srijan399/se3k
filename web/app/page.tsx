import { redirect } from 'next/navigation';

// There's no single graph anymore — each Slack workspace has its own,
// partitioned by team id. Land on the workspace picker instead.
export default function Home() {
  redirect('/workspaces');
}
