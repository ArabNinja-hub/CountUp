import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './constants';

const password = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);
const identifier = z.string().trim().min(3).max(254);

export const signupSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password,
    displayName: z.string().trim().min(1).max(120),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9]{9,15}$/, 'phone must be 9-15 digits with an optional leading +')
      .optional(),
  })
  .strict();

export const loginSchema = z
  .object({
    identifier,
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: password,
  })
  .strict();

export const recoveryRequestSchema = z.object({ identifier }).strict();

export const recoveryConfirmSchema = z
  .object({
    token: z.string().min(20).max(512),
    newPassword: password,
  })
  .strict();

export const adminVerifySchema = z
  .object({
    decision: z.enum(['approved', 'rejected']),
    evidence: z.record(z.string(), z.unknown()).default({}),
    notes: z.string().max(500).optional(),
  })
  .strict();

export const adminResetSchema = z
  .object({
    evidence: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const uuidParamSchema = z.string().uuid();

export type SignupBody = z.output<typeof signupSchema>;
export type LoginBody = z.output<typeof loginSchema>;
export type PasswordChangeBody = z.output<typeof passwordChangeSchema>;
export type RecoveryRequestBody = z.output<typeof recoveryRequestSchema>;
export type RecoveryConfirmBody = z.output<typeof recoveryConfirmSchema>;
export type AdminVerifyBody = z.output<typeof adminVerifySchema>;
export type AdminResetBody = z.output<typeof adminResetSchema>;
