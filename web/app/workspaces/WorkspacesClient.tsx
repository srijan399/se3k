'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import AddToSlackButton from '../../components/AddToSlackButton';
import { inter, plexMono, sans, mono } from '../fonts';
import type { Session } from '../lib/session';

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

const DIALOG_TRANSITION_MS = 180;

const pillButton = (color: string, borderColor: string) => ({
  textDecoration: 'none',
  color,
  border: `1px solid ${borderColor}`,
  borderRadius: '8px',
  padding: '7px 14px',
  fontSize: '12.5px',
  fontWeight: 600,
  background: 'transparent',
  cursor: 'pointer',
});

export default function WorkspacesClient({ session }: { session: Session }) {
  const [installs, setInstalls] = useState<Installation[]>([]);
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [channels, setChannels] = useState<Record<string, Channel[]>>({});
  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [autoJoin, setAutoJoin] = useState<Record<string, boolean>>({});
  const [jobs, setJobs] = useState<Record<string, BackfillJob | null>>({});
  const [uninstallTarget, setUninstallTarget] = useState<{
    teamId: string;
    teamName: string | null;
  } | null>(null);
  const [dialogMounted, setDialogMounted] = useState(false);
  const [dialogVisible, setDialogVisible] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const openUninstallDialog = (teamId: string, teamName: string | null) => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setUninstallTarget({ teamId, teamName });
    setDialogMounted(true);
    // Mount at the "hidden" position first, then flip to visible on the next
    // frame so the transition actually has a starting state to animate from.
    requestAnimationFrame(() => requestAnimationFrame(() => setDialogVisible(true)));
  };

  const closeUninstallDialog = () => {
    setDialogVisible(false);
    closeTimer.current = setTimeout(() => {
      setDialogMounted(false);
      setUninstallTarget(null);
    }, DIALOG_TRANSITION_MS);
  };

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
    else if (error === 'install_failed')
      setBanner(
        "Authorized with Slack, but couldn't reach the backend to finish the install. Give it a few seconds and click Add to Slack again.",
      );
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
      const res = await fetch(`/api/workspaces/${teamId}/channels`, {
        cache: 'no-store',
      });
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
      alert(
        'Pick at least one channel, or check "auto-join all public channels".',
      );
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
    const res = await fetch(`/api/workspaces/${teamId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setBanner(`Couldn't uninstall ${who}: ${d?.error || res.statusText}`);
      return;
    }
    setInstalls((list) => list.filter((i) => i.teamId !== teamId));
    if (expanded === teamId) setExpanded(null);
    setBanner(`Uninstalled ${who}.`);
  };

  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/workspaces';
  };

  return (
    <div
      className={`${inter.variable} ${plexMono.variable}`}
      style={{
        background: '#26082A',
        minHeight: '100vh',
        fontFamily: sans,
        color: '#F3EAF4',
      }}
    >
      {/* NAV */}
      <nav
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '22px 56px',
          maxWidth: '1280px',
          margin: '0 auto',
        }}
      >
        <Link
          href="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            textDecoration: 'none',
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="SE3K"
            width={40}
            height={40}
            style={{ width: '40px', height: '40px', borderRadius: '9px' }}
          />
          <span
            style={{
              fontFamily: mono,
              fontWeight: 600,
              fontSize: '17px',
              letterSpacing: '0.5px',
              color: '#FFFFFF',
            }}
          >
            SE3K
          </span>
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <Link
            href="/"
            style={{
              textDecoration: 'none',
              color: '#D8C6DB',
              fontSize: '14px',
              fontWeight: 500,
            }}
          >
            &larr; Home
          </Link>
          <span
            style={{
              fontSize: '12.5px',
              color: '#7A6A7D',
              fontFamily: mono,
            }}
          >
            {session.name || session.userId} &middot;{' '}
            {session.teamName || session.teamId}
          </span>
          <button onClick={signOut} style={pillButton('#D8C6DB', 'rgba(255,255,255,0.15)')}>
            Sign out
          </button>
          <AddToSlackButton />
        </div>
      </nav>

      {/* HEADER */}
      <div
        style={{ maxWidth: '900px', margin: '0 auto', padding: '48px 32px 0' }}
      >
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            padding: '6px 14px',
            borderRadius: '999px',
            fontFamily: mono,
            fontSize: '12px',
            color: '#ECB22E',
            marginBottom: '20px',
          }}
        >
          <span
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: '#ECB22E',
            }}
          />
          CONNECTED WORKSPACES
        </div>
        <h1
          style={{
            fontSize: '38px',
            fontWeight: 800,
            color: '#FFFFFF',
            margin: '0 0 12px',
            letterSpacing: '-1px',
          }}
        >
          Your workspaces
        </h1>
        <p
          style={{
            color: '#D8C6DB',
            fontSize: '15.5px',
            lineHeight: 1.6,
            maxWidth: '560px',
            margin: '0 0 28px',
          }}
        >
          Connect a Slack workspace, then backfill its history so the knowledge
          graph isn&apos;t starting from a blank slate.
        </p>

        {banner && (
          <div
            style={{
              marginBottom: '24px',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '10px',
              padding: '10px 16px',
              fontSize: '13.5px',
              color: '#D8C6DB',
            }}
          >
            {banner}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
            paddingBottom: '100px',
          }}
        >
          {loading && (
            <p style={{ color: '#7A6A7D', fontSize: '14px' }}>
              Loading&hellip;
            </p>
          )}
          {!loading && installs.length === 0 && (
            <p style={{ color: '#7A6A7D', fontSize: '14px' }}>
              No workspaces connected yet &mdash; click &ldquo;Add to
              Slack&rdquo; above.
            </p>
          )}
          {installs.map((install) => {
            const job = jobs[install.teamId];
            return (
              <div
                key={install.teamId}
                style={{
                  background: '#2B0A32',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '16px',
                  padding: '20px 24px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '16px',
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: '16px',
                        color: '#FFFFFF',
                      }}
                    >
                      {install.teamName || install.teamId}
                    </div>
                    <div
                      style={{
                        fontFamily: mono,
                        fontSize: '11.5px',
                        color: '#7A6A7D',
                        marginTop: '4px',
                      }}
                    >
                      {install.teamId} &middot; installed{' '}
                      {new Date(install.installedAt).toLocaleDateString()}
                    </div>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      flexShrink: 0,
                    }}
                  >
                    <a
                      href="/g"
                      style={pillButton('#D8C6DB', 'rgba(255,255,255,0.15)')}
                    >
                      View graph
                    </a>
                    <button
                      onClick={() => toggleExpand(install.teamId)}
                      style={pillButton('#D8C6DB', 'rgba(255,255,255,0.15)')}
                    >
                      {expanded === install.teamId ? 'Close' : 'Backfill'}
                    </button>
                    <button
                      onClick={() =>
                        openUninstallDialog(install.teamId, install.teamName)
                      }
                      style={pillButton('#E01E5A', 'rgba(224,30,90,0.4)')}
                    >
                      Uninstall
                    </button>
                  </div>
                </div>

                {expanded === install.teamId && (
                  <div
                    style={{
                      marginTop: '20px',
                      borderTop: '1px solid rgba(255,255,255,0.08)',
                      paddingTop: '20px',
                    }}
                  >
                    <label
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '14px',
                        color: '#D8C6DB',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={!!autoJoin[install.teamId]}
                        onChange={(e) =>
                          setAutoJoin((a) => ({
                            ...a,
                            [install.teamId]: e.target.checked,
                          }))
                        }
                      />
                      Auto-join &amp; backfill every public channel
                    </label>
                    <p
                      style={{
                        marginTop: '6px',
                        fontSize: '12.5px',
                        color: '#7A6A7D',
                      }}
                    >
                      Private channels always need a manual /invite first
                      &mdash; pick them below.
                    </p>

                    {!autoJoin[install.teamId] && (
                      <div
                        style={{
                          marginTop: '14px',
                          maxHeight: '192px',
                          overflowY: 'auto',
                          borderRadius: '10px',
                          border: '1px solid rgba(255,255,255,0.08)',
                          padding: '8px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '2px',
                        }}
                      >
                        {(channels[install.teamId] || []).map((c) => (
                          <label
                            key={c.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              borderRadius: '6px',
                              padding: '6px 8px',
                              fontSize: '13.5px',
                              color: '#F3EAF4',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={
                                selected[install.teamId]?.has(c.id) || false
                              }
                              onChange={() =>
                                toggleChannel(install.teamId, c.id)
                              }
                              disabled={!c.isMember && c.isPrivate}
                            />
                            <span>
                              {c.isPrivate ? '🔒' : '#'} {c.name}
                            </span>
                            {!c.isMember && !c.isPrivate && (
                              <span
                                style={{ fontSize: '11.5px', color: '#7A6A7D' }}
                              >
                                (will auto-join)
                              </span>
                            )}
                            {!c.isMember && c.isPrivate && (
                              <span
                                style={{ fontSize: '11.5px', color: '#7A6A7D' }}
                              >
                                (invite the bot first)
                              </span>
                            )}
                          </label>
                        ))}
                        {channels[install.teamId]?.length === 0 && (
                          <p
                            style={{
                              padding: '6px 8px',
                              fontSize: '12.5px',
                              color: '#7A6A7D',
                            }}
                          >
                            No channels found.
                          </p>
                        )}
                      </div>
                    )}

                    <button
                      onClick={() => startBackfill(install.teamId)}
                      disabled={
                        job?.status === 'pending' || job?.status === 'running'
                      }
                      style={{
                        marginTop: '14px',
                        background: '#2EB67D',
                        color: '#0F2E1F',
                        fontWeight: 700,
                        fontSize: '12.5px',
                        padding: '9px 18px',
                        borderRadius: '8px',
                        border: 'none',
                        cursor: 'pointer',
                        opacity:
                          job?.status === 'pending' || job?.status === 'running'
                            ? 0.5
                            : 1,
                      }}
                    >
                      Start backfill
                    </button>

                    {job && (
                      <div
                        style={{
                          marginTop: '12px',
                          fontFamily: mono,
                          fontSize: '12px',
                          color: '#7A6A7D',
                        }}
                      >
                        {job.status === 'failed' ? (
                          <span style={{ color: '#E01E5A' }}>
                            Failed: {job.error}
                          </span>
                        ) : (
                          <>
                            {job.status} &middot; {job.channelsDone}/
                            {job.channelsTotal} channel(s) &middot;{' '}
                            {job.messagesProcessed} message(s) ingested
                            {job.error && (
                              <span
                                style={{ display: 'block', color: '#ECB22E' }}
                              >
                                &#9888; {job.error}
                              </span>
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

      {dialogMounted && uninstallTarget && (
        <div
          role="presentation"
          onClick={closeUninstallDialog}
          style={{
            position: 'fixed',
            inset: 0,
            background: dialogVisible
              ? 'rgba(0,0,0,0.55)'
              : 'rgba(0,0,0,0)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
            zIndex: 1000,
            transition: `background ${DIALOG_TRANSITION_MS}ms ease`,
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="uninstall-dialog-title"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#2B0A32',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: '16px',
              padding: '28px',
              maxWidth: '420px',
              width: '100%',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
              opacity: dialogVisible ? 1 : 0,
              transform: dialogVisible
                ? 'scale(1) translateY(0)'
                : 'scale(0.94) translateY(10px)',
              transition: `opacity ${DIALOG_TRANSITION_MS}ms ease, transform ${DIALOG_TRANSITION_MS}ms cubic-bezier(0.16, 1, 0.3, 1)`,
            }}
          >
            <h2
              id="uninstall-dialog-title"
              style={{
                margin: '0 0 12px',
                fontSize: '18px',
                fontWeight: 700,
                color: '#FFFFFF',
              }}
            >
              Uninstall SE3K from{' '}
              {uninstallTarget.teamName || uninstallTarget.teamId}?
            </h2>
            <p
              style={{
                margin: '0 0 24px',
                fontSize: '14px',
                lineHeight: 1.6,
                color: '#D8C6DB',
              }}
            >
              This removes SE3K from your Slack workspace and permanently
              deletes its graph, backfill history, and dedupe records. You
              can re-add it anytime with &ldquo;Add to Slack&rdquo;.
            </p>
            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: '10px',
              }}
            >
              <button
                onClick={closeUninstallDialog}
                style={pillButton('#D8C6DB', 'rgba(255,255,255,0.15)')}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const { teamId, teamName } = uninstallTarget;
                  closeUninstallDialog();
                  uninstall(teamId, teamName);
                }}
                style={{
                  ...pillButton('#0F2E1F', 'transparent'),
                  background: '#E01E5A',
                  color: '#FFFFFF',
                }}
              >
                Uninstall
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
