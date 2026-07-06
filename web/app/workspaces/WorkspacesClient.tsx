'use client';

import { useCallback, useEffect, useState } from 'react';

interface Installation {
  teamId: string;
  teamName: string | null;
  botUserId: string | null;
  installedAt: string;
}

interface Channel {
  id: string;
  name: string;
  isMember: boolean;
  isPrivate: boolean;
}

interface BackfillJob {
  id: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  messagesProcessed: number;
  channelsTotal: number;
  channelsDone: number;
  error: string | null;
}

export default function WorkspacesClient({ dashboardKey }: { dashboardKey: string | null }) {
  const [installs, setInstalls] = useState<Installation[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [channels, setChannels] = useState<Record<string, Channel[]>>({});
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [autoJoin, setAutoJoin] = useState<Record<string, boolean>>({});
  const [jobs, setJobs] = useState<Record<string, BackfillJob | null>>({});

  const loadInstalls = useCallback(async () => {
    const res = await fetch('/api/workspaces', { cache: 'no-store' });
    setInstalls(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    loadInstalls();
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connected');
    const error = params.get('error');
    if (connected) setBanner(`Connected workspace ${connected}.`);
    else if (error) setBanner(`Slack OAuth error: ${error}`);
    if (connected || error) window.history.replaceState({}, '', '/workspaces');
  }, [loadInstalls]);

  const toggleExpand = async (teamId: string) => {
    if (expanded === teamId) {
      setExpanded(null);
      return;
    }
    setExpanded(teamId);
    if (!channels[teamId]) {
      const res = await fetch(`/api/workspaces/${teamId}/channels`, { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data)) {
        setBanner(
          `Couldn't load channels for ${teamId}: ${data?.error || res.statusText}. ` +
            'If you just changed OAuth scopes, reconnect this workspace via "Add to Slack" first.',
        );
        setChannels((c) => ({ ...c, [teamId]: [] }));
        return;
      }
      setChannels((c) => ({ ...c, [teamId]: data }));
    }
  };

  const toggleChannel = (teamId: string, channelId: string) => {
    setSelected((s) => {
      const next = new Set(s[teamId] || []);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return { ...s, [teamId]: next };
    });
  };

  const poll = useCallback((teamId: string, jobId: number) => {
    const tick = async () => {
      const res = await fetch(`/api/workspaces/${teamId}/backfill/${jobId}`, {
        cache: 'no-store',
      });
      const job = (await res.json()) as BackfillJob;
      setJobs((j) => ({ ...j, [teamId]: job }));
      if (job.status === 'pending' || job.status === 'running') {
        setTimeout(tick, 2000);
      }
    };
    tick();
  }, []);

  const startBackfill = async (teamId: string) => {
    const chosen = [...(selected[teamId] || [])];
    const joinAll = !!autoJoin[teamId];
    if (!joinAll && chosen.length === 0) {
      alert('Pick at least one channel, or check "auto-join all public channels".');
      return;
    }
    const res = await fetch(`/api/workspaces/${teamId}/backfill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        joinAll ? { autoJoinPublic: true } : { channelIds: chosen },
      ),
    });
    const { jobId } = await res.json();
    if (jobId) poll(teamId, jobId);
  };

  const uninstall = async (teamId: string, teamName: string | null) => {
    const who = teamName || teamId;
    if (
      !confirm(
        `Uninstall SE3K from ${who}?\n\n` +
          "This removes SE3K from your Slack workspace and permanently deletes its graph, " +
          'backfill history, and dedupe records. You can re-add it anytime with "Add to Slack".',
      )
    )
      return;
    const res = await fetch(`/api/workspaces/${teamId}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setBanner(`Couldn't uninstall ${who}: ${d?.error || res.statusText}`);
      return;
    }
    setInstalls((list) => list.filter((i) => i.teamId !== teamId));
    if (expanded === teamId) setExpanded(null);
    setBanner(`Uninstalled ${who}.`);
  };

  const dashboardHref = (teamId: string) =>
    dashboardKey ? `/g/${dashboardKey}?team=${encodeURIComponent(teamId)}` : null;

  return (
    <div className="min-h-screen bg-[#0b0b12] px-6 py-10 text-zinc-100">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">SE3K Workspaces</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Connect a Slack workspace, then backfill its history so the knowledge graph
          isn&apos;t starting from a blank slate.
        </p>

        <div className="mt-6 flex items-center gap-3">
          {/* Official "Add to Slack" button. Points at our own /api/slack/install
              route (not the raw slack.com/authorize URL) so the redirect_uri is set
              to this origin's callback and the requested scopes stay in sync. */}
          <a href="/api/slack/install" aria-label="Add SE3K to Slack">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt="Add to Slack"
              height={40}
              width={139}
              src="https://platform.slack-edge.com/img/add_to_slack.png"
              srcSet="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x"
            />
          </a>
        </div>

        {banner && (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-2 text-sm text-zinc-300">
            {banner}
          </div>
        )}

        <div className="mt-8 space-y-3">
          {loading && <p className="text-sm text-zinc-500">Loading…</p>}
          {!loading && installs.length === 0 && (
            <p className="text-sm text-zinc-500">
              No workspaces connected yet — click &ldquo;Add to Slack&rdquo; above.
            </p>
          )}
          {installs.map((install) => {
            const job = jobs[install.teamId];
            const href = dashboardHref(install.teamId);
            return (
              <div
                key={install.teamId}
                className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{install.teamName || install.teamId}</div>
                    <div className="text-xs text-zinc-500">
                      {install.teamId} · installed{' '}
                      {new Date(install.installedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {href && (
                      <a
                        href={href}
                        className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs hover:border-zinc-500"
                      >
                        View graph
                      </a>
                    )}
                    <button
                      onClick={() => toggleExpand(install.teamId)}
                      className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs hover:border-zinc-500"
                    >
                      {expanded === install.teamId ? 'Close' : 'Backfill'}
                    </button>
                    <button
                      onClick={() => uninstall(install.teamId, install.teamName)}
                      className="rounded-lg border border-red-900/60 px-3 py-1.5 text-xs text-red-300 hover:border-red-500 hover:text-red-200"
                    >
                      Uninstall
                    </button>
                  </div>
                </div>

                {expanded === install.teamId && (
                  <div className="mt-4 border-t border-zinc-800 pt-4">
                    <label className="flex items-center gap-2 text-sm text-zinc-300">
                      <input
                        type="checkbox"
                        checked={!!autoJoin[install.teamId]}
                        onChange={(e) =>
                          setAutoJoin((a) => ({ ...a, [install.teamId]: e.target.checked }))
                        }
                      />
                      Auto-join &amp; backfill every public channel
                    </label>
                    <p className="mt-1 text-xs text-zinc-500">
                      Private channels always need a manual /invite first — pick them below.
                    </p>

                    {!autoJoin[install.teamId] && (
                      <div className="mt-3 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-zinc-800 p-2">
                        {(channels[install.teamId] || []).map((c) => (
                          <label
                            key={c.id}
                            className="flex items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-zinc-800/60"
                          >
                            <input
                              type="checkbox"
                              checked={selected[install.teamId]?.has(c.id) || false}
                              onChange={() => toggleChannel(install.teamId, c.id)}
                              disabled={!c.isMember && c.isPrivate}
                            />
                            <span>
                              {c.isPrivate ? '🔒' : '#'} {c.name}
                            </span>
                            {!c.isMember && !c.isPrivate && (
                              <span className="text-xs text-zinc-500">(will auto-join)</span>
                            )}
                            {!c.isMember && c.isPrivate && (
                              <span className="text-xs text-zinc-500">(invite the bot first)</span>
                            )}
                          </label>
                        ))}
                        {channels[install.teamId]?.length === 0 && (
                          <p className="px-1.5 py-1 text-xs text-zinc-500">No channels found.</p>
                        )}
                      </div>
                    )}

                    <button
                      onClick={() => startBackfill(install.teamId)}
                      disabled={job?.status === 'pending' || job?.status === 'running'}
                      className="mt-3 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      Start backfill
                    </button>

                    {job && (
                      <div className="mt-3 text-xs text-zinc-400">
                        {job.status === 'failed' ? (
                          <span className="text-red-400">Failed: {job.error}</span>
                        ) : (
                          <>
                            {job.status} · {job.channelsDone}/{job.channelsTotal} channel(s) ·{' '}
                            {job.messagesProcessed} message(s) ingested
                            {job.error && (
                              <span className="block text-amber-400">⚠️ {job.error}</span>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
