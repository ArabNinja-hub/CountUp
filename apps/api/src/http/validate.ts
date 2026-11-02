import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

export class RequestValidationError extends Error {
  constructor(readonly details: string[]) {
    super(`Request validation failed: ${details.join('; ')}`);
    this.name = 'RequestValidationError';
  }
}

/** Parse untrusted input. Throws instead of ever returning partially-valid data. */
export function parseWith<Schema extends z.ZodType>(
  schema: Schema,
  data: unknown
): z.output<Schema> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new RequestValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    );
  }
  return result.data;
}

/** Express middleware: validates JSON body and replaces it with parsed output. */
export function validateBody<Schema extends z.ZodType>(schema: Schema) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.body = parseWith(schema, req.body);
      next();
    } catch (error) {
      next(error);
    }
  };
}
