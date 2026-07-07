import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import AddToSlackButton from './AddToSlackButton';
import SmoothAnchor from './SmoothAnchor';
import { inter, plexMono, sans, mono } from './fonts';

export const metadata: Metadata = {
  title: 'SE3K — Who actually knows this?',
  description:
    "SE3K surfaces who really knows about X — ranked by demonstrated work, not who's assigned — and why past decisions were made, with receipts.",
};

const GITHUB_HREF = 'https://github.com/srijan399/se3k';

const PROBLEMS = [
  {
    color: '#E01E5A',
    title: 'Assigned ≠ expert',
    text: "Jira says Dana owns it. Dana moved on months ago.",
  },
  {
    color: '#ECB22E',
    title: 'Scattered, not gone',
    text: 'The real expertise lives in threads that scrolled off weeks ago.',
  },
  {
    color: '#36C5F0',
    title: 'Unsearchable',
    text: 'No ticket tracker answers "who do I actually talk to?"',
  },
];

const DIAGRAM = [
  {
    size: 64,
    bg: '#36C5F0',
    fg: '#04303F',
    delay: '0s',
    label: 'B',
    title: 'The Bot',
    sub: 'Bolt · Socket Mode',
    text: 'A genuine MCP client. Authorizes per-message across every installed workspace.',
    border: false,
    glow: false,
  },
  {
    size: 72,
    bg: '#ECB22E',
    fg: '#3B2A05',
    delay: '0.3s',
    label: 'MCP',
    title: 'The Brain',
    sub: 'MCP server · Postgres',
    text: 'Extracts weighted, time-decayed edges. Resolves facts before the model speaks.',
    border: true,
    glow: true,
  },
  {
    size: 64,
    bg: '#2EB67D',
    fg: '#0F2E1F',
    delay: '0.6s',
    label: 'D',
    title: 'The Dashboard',
    sub: 'Next.js · force-graph',
    text: 'Slack OAuth install, backfill progress, and the live knowledge graph.',
    border: false,
    glow: false,
  },
];

const FEATURES = [
  {
    n: '01',
    color: '#E01E5A',
    title: 'Ranks by proof',
    text: 'A weighted, decaying Person→Project edge means whoever did the work outranks whoever\'s "assigned."',
  },
  {
    n: '02',
    color: '#ECB22E',
    title: 'Every claim is sourced',
    text: 'Each citation links straight to the Slack message it came from. Trust, but verify.',
  },
  {
    n: '03',
    color: '#36C5F0',
    title: 'Instant repeat answers',
    text: 'A semantic cache answers reworded questions with zero LLM calls, and self-invalidates on new messages.',
  },
  {
    n: '04',
    color: '#2EB67D',
    title: 'One-click install',
    text: 'Slack OAuth from the dashboard connects a workspace in a click — each gets its own isolated graph.',
  },
  {
    n: '05',
    color: '#E01E5A',
    title: 'Catches up on years',
    text: 'A one-click backfill job walks the entire channel history, with live progress in the dashboard.',
  },
  {
    n: '06',
    color: '#ECB22E',
    title: 'Live graph dashboard',
    text: "Watch the org's knowledge network grow in real time, colored by type, sized by involvement.",
  },
];

export default function Home() {
  return (
    <div
      className={`${inter.variable} ${plexMono.variable} se3k-landing`}
      style={{
        background: '#26082A',
        minHeight: '100vh',
        fontFamily: sans,
        color: '#F3EAF4',
      }}
    >
      <style>{`.se3k-landing ::selection { background: #ECB22E; color: #3B0E3F; }`}</style>

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Image
            src="/logo.png"
            alt="SE3K"
            width={52}
            height={52}
            style={{ width: '52px', height: '52px', borderRadius: '10px' }}
          />
          <span
            style={{
              fontFamily: mono,
              fontWeight: 600,
              fontSize: '18px',
              letterSpacing: '0.5px',
              color: '#FFFFFF',
            }}
          >
            SE3K
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '32px' }}>
          <SmoothAnchor
            href="#how"
            style={{
              textDecoration: 'none',
              color: '#D8C6DB',
              fontSize: '14px',
              fontWeight: 500,
            }}
          >
            How it works
          </SmoothAnchor>
          <Link
            href="/workspaces"
            style={{
              textDecoration: 'none',
              color: '#D8C6DB',
              fontSize: '14px',
              fontWeight: 500,
            }}
          >
            Workspaces
          </Link>
          <a
            href={GITHUB_HREF}
            style={{
              textDecoration: 'none',
              color: '#D8C6DB',
              fontSize: '14px',
              fontWeight: 500,
            }}
          >
            GitHub
          </a>
          <AddToSlackButton />
        </div>
      </nav>

      {/* HERO */}
      <section
        style={{
          maxWidth: '1280px',
          margin: '0 auto',
          padding: '72px 56px 100px',
          display: 'grid',
          gridTemplateColumns: '1.05fr 0.95fr',
          gap: '56px',
          alignItems: 'center',
        }}
      >
        <div>
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
              marginBottom: '28px',
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
            AN ORG BRAIN THAT LIVES IN SLACK
          </div>
          <h1
            style={{
              fontSize: '56px',
              lineHeight: 1.06,
              fontWeight: 800,
              margin: '0 0 24px',
              color: '#FFFFFF',
              letterSpacing: '-1.5px',
            }}
          >
            &ldquo;Who actually
            <br />
            knows this?&rdquo;
          </h1>
          <p
            style={{
              fontSize: '18px',
              lineHeight: 1.6,
              color: '#D8C6DB',
              maxWidth: '480px',
              margin: '0 0 36px',
            }}
          >
            SE3K surfaces who really knows about X &mdash; ranked by
            demonstrated work, not who&apos;s assigned &mdash; and why past
            decisions were made, with receipts.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <AddToSlackButton />
            <SmoothAnchor
              href="#how"
              style={{
                textDecoration: 'none',
                color: '#F3EAF4',
                fontWeight: 600,
                fontSize: '15px',
                borderBottom: '1px solid rgba(255,255,255,0.3)',
                paddingBottom: '2px',
              }}
            >
              See how it works &darr;
            </SmoothAnchor>
          </div>
        </div>

        {/* SLACK DEMO CARD */}
        <div
          style={{
            background: '#2B0A32',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '16px',
            boxShadow: '0 30px 80px rgba(0,0,0,0.45)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '14px 18px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(0,0,0,0.15)',
            }}
          >
            <span
              style={{
                width: '11px',
                height: '11px',
                borderRadius: '50%',
                background: '#E01E5A',
              }}
            />
            <span
              style={{
                width: '11px',
                height: '11px',
                borderRadius: '50%',
                background: '#ECB22E',
              }}
            />
            <span
              style={{
                width: '11px',
                height: '11px',
                borderRadius: '50%',
                background: '#2EB67D',
              }}
            />
            <span
              style={{
                fontFamily: mono,
                fontSize: '12px',
                color: '#9C889F',
                marginLeft: '8px',
              }}
            >
              #backend
            </span>
          </div>
          <div
            style={{
              padding: '24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '18px',
            }}
          >
            <div style={{ display: 'flex', gap: '12px' }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '8px',
                  background: '#36C5F0',
                  flex: 'none',
                }}
              />
              <div>
                <div
                  style={{
                    fontSize: '13px',
                    color: '#9C889F',
                    marginBottom: '4px',
                    fontFamily: mono,
                  }}
                >
                  you
                </div>
                <div
                  style={{
                    background: 'rgba(255,255,255,0.06)',
                    borderRadius: '10px',
                    padding: '10px 14px',
                    fontSize: '14.5px',
                    color: '#F3EAF4',
                    display: 'inline-block',
                  }}
                >
                  who do I talk to about the checkout timeouts?
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '12px' }}>
              <div
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '8px',
                  background: '#ECB22E',
                  flex: 'none',
                }}
              />
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontSize: '13px',
                    color: '#9C889F',
                    marginBottom: '4px',
                    fontFamily: mono,
                  }}
                >
                  SE3K{' '}
                  <span
                    style={{
                      background: 'rgba(46,182,125,0.2)',
                      color: '#2EB67D',
                      padding: '1px 6px',
                      borderRadius: '4px',
                      fontSize: '10.5px',
                      marginLeft: '4px',
                    }}
                  >
                    APP
                  </span>
                </div>
                <div
                  style={{
                    background: 'rgba(46,182,125,0.08)',
                    border: '1px solid rgba(46,182,125,0.25)',
                    borderRadius: '10px',
                    padding: '14px 16px',
                    fontSize: '14.5px',
                    lineHeight: 1.55,
                    color: '#EDEAF0',
                  }}
                >
                  Talk to{' '}
                  <a
                    href="#"
                    style={{
                      color: '#36C5F0',
                      fontWeight: 600,
                      textDecoration: 'none',
                    }}
                  >
                    @Ivan Sanders
                  </a>
                  . He traced it to Postgres connection-pool exhaustion and
                  shipped PgBouncer (checkout p95 9s &rarr; 700ms). Adam owns
                  the service on paper but handed it off.
                  <div
                    style={{
                      marginTop: '10px',
                      fontFamily: mono,
                      fontSize: '12px',
                      color: '#7fd4f0',
                      borderLeft: '2px solid rgba(54,197,240,0.4)',
                      paddingLeft: '10px',
                    }}
                  >
                    &bull; #backend: &ldquo;Shipped PgBouncer connection
                    pooling; p95 dropped 9s &rarr; 700ms&rdquo;
                  </div>
                </div>
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                paddingTop: '4px',
              }}
            >
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: '#2EB67D',
                  animation: 'blink 1.4s infinite',
                }}
              />
              <span
                style={{
                  fontFamily: mono,
                  fontSize: '11.5px',
                  color: '#7A6A7D',
                }}
              >
                answered from the graph &middot; 0 hallucinated facts
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* PROBLEM STRIP */}
      <section
        style={{
          borderTop: '1px solid rgba(255,255,255,0.08)',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(0,0,0,0.15)',
        }}
      >
        <div
          style={{
            maxWidth: '1280px',
            margin: '0 auto',
            padding: '40px 56px',
            display: 'grid',
            gridTemplateColumns: 'repeat(3,1fr)',
            gap: '40px',
          }}
        >
          {PROBLEMS.map((p) => (
            <div key={p.title}>
              <div
                style={{
                  fontFamily: mono,
                  fontSize: '32px',
                  fontWeight: 700,
                  color: p.color,
                }}
              >
                {p.title}
              </div>
              <p
                style={{
                  color: '#B8A5BB',
                  fontSize: '14.5px',
                  lineHeight: 1.5,
                  marginTop: '8px',
                }}
              >
                {p.text}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section
        id="how"
        style={{ maxWidth: '1280px', margin: '0 auto', padding: '100px 56px 60px' }}
      >
        <div style={{ textAlign: 'center', marginBottom: '64px' }}>
          <div
            style={{
              fontFamily: mono,
              fontSize: '12px',
              letterSpacing: '1.5px',
              color: '#7fd4f0',
              marginBottom: '14px',
            }}
          >
            HOW IT WORKS
          </div>
          <h2
            style={{
              fontSize: '38px',
              fontWeight: 800,
              color: '#FFFFFF',
              margin: '0 0 16px',
              letterSpacing: '-1px',
            }}
          >
            Three small services. One brain.
          </h2>
          <p
            style={{
              color: '#D8C6DB',
              fontSize: '16px',
              maxWidth: '600px',
              margin: '0 auto',
              lineHeight: 1.6,
            }}
          >
            The MCP server is the brain &mdash; everything else is I/O. It
            resolves facts from the graph in code first, and only asks the
            model to phrase them.
          </p>
        </div>

        {/* diagram */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 0,
            alignItems: 'stretch',
            marginBottom: '72px',
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: 0,
              right: 0,
              height: '2px',
              background:
                'linear-gradient(90deg, transparent, rgba(255,255,255,0.15) 15%, rgba(255,255,255,0.15) 85%, transparent)',
              zIndex: 0,
            }}
          />
          {DIAGRAM.map((d) => (
            <div
              key={d.title}
              style={{
                position: 'relative',
                zIndex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '14px',
                padding: '0 20px',
                borderLeft: d.border ? '1px dashed rgba(255,255,255,0.12)' : undefined,
                borderRight: d.border ? '1px dashed rgba(255,255,255,0.12)' : undefined,
              }}
            >
              <div
                style={{
                  width: `${d.size}px`,
                  height: `${d.size}px`,
                  borderRadius: d.size === 72 ? '18px' : '16px',
                  background: d.bg,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontFamily: mono,
                  fontWeight: 700,
                  fontSize: d.size === 72 ? '24px' : '22px',
                  color: d.fg,
                  animation: `floatnode 4s ease-in-out infinite ${d.delay}`,
                  boxShadow: d.glow ? '0 0 0 6px rgba(236,178,46,0.12)' : undefined,
                }}
              >
                {d.label}
              </div>
              <div style={{ fontWeight: 700, fontSize: '15px', color: '#FFFFFF' }}>
                {d.title}
              </div>
              <div style={{ fontFamily: mono, fontSize: '11.5px', color: '#7A6A7D' }}>
                {d.sub}
              </div>
              <p
                style={{
                  textAlign: 'center',
                  color: '#B8A5BB',
                  fontSize: '13.5px',
                  lineHeight: 1.5,
                  maxWidth: '220px',
                }}
              >
                {d.text}
              </p>
            </div>
          ))}
        </div>

        {/* feature grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3,1fr)',
            gap: '20px',
          }}
        >
          {FEATURES.map((f) => (
            <div
              key={f.n}
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '14px',
                padding: '24px',
              }}
            >
              <div
                style={{
                  fontFamily: mono,
                  fontSize: '13px',
                  color: f.color,
                  marginBottom: '10px',
                }}
              >
                {f.n}
              </div>
              <div
                style={{
                  fontWeight: 700,
                  fontSize: '16px',
                  color: '#FFFFFF',
                  marginBottom: '8px',
                }}
              >
                {f.title}
              </div>
              <p style={{ color: '#B8A5BB', fontSize: '13.5px', lineHeight: 1.6, margin: 0 }}>
                {f.text}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA FOOTER */}
      <section id="cta" style={{ maxWidth: '1280px', margin: '80px auto 0', padding: '0 56px' }}>
        <div
          style={{
            background: '#2B0A32',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '24px',
            padding: '64px 56px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '40px',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '-80px',
              right: '-80px',
              width: '280px',
              height: '280px',
              borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(46,182,125,0.25), transparent 70%)',
              pointerEvents: 'none',
            }}
          />
          <div style={{ position: 'relative' }}>
            <h2
              style={{
                fontSize: '32px',
                fontWeight: 800,
                color: '#FFFFFF',
                margin: '0 0 10px',
                letterSpacing: '-0.5px',
              }}
            >
              Give your team an org brain.
            </h2>
            <p style={{ color: '#B8A5BB', fontSize: '15.5px', margin: 0 }}>
              Free to install. Learns from day one.
            </p>
          </div>
          <AddToSlackButton className="relative" />
        </div>
      </section>

      {/* FOOTER */}
      <footer
        style={{
          maxWidth: '1280px',
          margin: '0 auto',
          padding: '56px 56px 40px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          marginTop: '64px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Image
            src="/logo.png"
            alt="SE3K"
            width={32}
            height={32}
            style={{ width: '32px', height: '32px', borderRadius: '7px' }}
          />
          <span style={{ fontFamily: mono, fontSize: '13px', color: '#9C889F' }}>
            SE3K &middot; who actually knows this?
          </span>
        </div>
        <a href={GITHUB_HREF} style={{ textDecoration: 'none', color: '#9C889F', fontSize: '13.5px' }}>
          View source on GitHub
        </a>
      </footer>
    </div>
  );
}
