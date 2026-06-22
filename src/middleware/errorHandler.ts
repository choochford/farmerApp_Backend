import { Request, Response, NextFunction } from 'express';

// Catches anything that fell through a route's own try/catch (or wasn't
// wrapped in one) so the response always matches the error shape defined
// in backend-api-spec.md §12, instead of leaking a stack trace or hanging.
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  console.error('Unhandled error', err);
  if (res.headersSent) {
    // A streaming response (e.g. /v1/ai/chat) may already have sent
    // headers and partial body — can't change the status code at this point.
    return res.end();
  }
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', status: 500 },
  });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'VALIDATION_ERROR', message: 'Not found', status: 404 } });
}
