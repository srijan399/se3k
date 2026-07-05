import { NextFunction, Request, Response } from 'express';

const SECRET = process.env.INTERNAL_API_SECRET;

// hackathon shortcut: a single shared secret between web/slack-bot/mcp-server,
// not real service-to-service auth. Fine for a hackathon deployment; would
// move to per-service credentials before any production use.
export function requireInternalSecret(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!SECRET) {
    console.warn(
      '[se3k:http] INTERNAL_API_SECRET not set — internal routes are UNPROTECTED',
    );
    next();
    return;
  }
  if (req.header('x-internal-secret') !== SECRET) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
