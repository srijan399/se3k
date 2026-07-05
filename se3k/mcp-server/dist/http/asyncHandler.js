"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.asyncHandler = asyncHandler;
// Express 4 doesn't forward rejected promises from async handlers to error
// middleware — an uncaught rejection there crashes the whole process (found
// via a DB-outage smoke test: one bad query took down every workspace, not
// just one request). Wrap every handler with this instead of writing
// try/catch in each one.
function asyncHandler(fn) {
    return (req, res, next) => {
        fn(req, res).catch(next);
    };
}
