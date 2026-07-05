import { NextFunction, Request, Response } from 'express';

// Express 4 doesn't forward rejected promises from async handlers to error
// middleware — an uncaught rejection there crashes the whole process (found
// via a DB-outage smoke test: one bad query took down every workspace, not
// just one request). Wrap every handler with this instead of writing
// try/catch in each one.
export function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}
