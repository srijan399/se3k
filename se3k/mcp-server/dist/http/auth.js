"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireInternalSecret = requireInternalSecret;
const SECRET = process.env.INTERNAL_API_SECRET;
// hackathon shortcut: a single shared secret between web/slack-bot/mcp-server,
// not real service-to-service auth. Fine for a hackathon deployment; would
// move to per-service credentials before any production use.
function requireInternalSecret(req, res, next) {
    if (!SECRET) {
        console.warn('[se3k:http] INTERNAL_API_SECRET not set — internal routes are UNPROTECTED');
        next();
        return;
    }
    if (req.header('x-internal-secret') !== SECRET) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }
    next();
}
