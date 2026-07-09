'use client';

import type { CSSProperties, MouseEvent, ReactNode } from 'react';

export default function SmoothAnchor({
  href,
  children,
  style,
}: {
  href: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    const target = document.querySelector(href);
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <a href={href} onClick={onClick} style={style}>
      {children}
    </a>
  );
}
