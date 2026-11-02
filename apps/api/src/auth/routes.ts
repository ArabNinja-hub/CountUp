import { parse } from 'cookie';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import type { AppEnv } from '../config/env';
import { parseWith, validateBody } from '../http/validate';
import type { AuthContext, AuthService } from './auth-service';
import { REFRESH_COOKIE } from './constants';
import { clearSessionCookies, setSessionCookies, type CookiePolicy } from './cookies';
import { AuthError } from './errors';
import {
  getAuthContext,
  loginRateLimit,
  recoveryRateLimit,
  requireAuth,
  requireOwner,
  requirePlatformAdmin,
  requireVerified,
} from './middleware';
import type { SecurityOptions } from './security';
import {
  adminResetSchema,
  adminVerifySchema,
  loginSchema,
  passwordChangeSchema,
  recoveryConfirmSchema,
  recoveryRequestSchema,
  signupSchema,
  uuidParamSchema,
  type AdminResetBody,
  type AdminVerifyBody,
  type LoginBody,
  type PasswordChangeBody,
  type RecoveryConfirmBody,
  type RecoveryRequestBody,
  type SignupBody,
} from './schemas';
import { normaliseIp } from './tokens';

export interface AuthRouterOptions {
  service: AuthService;
  security: SecurityOptions;
  env: AppEnv;
}

type AsyncRoute = (req: Request, res: Response) => Promise<void>;

function wrap(route: AsyncRoute): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    void route(req, res).catch(next);
  };
}

function context(res: Response): AuthContext {
  const value = getAuthContext(res);
  if (value === null) {
    throw new AuthError('unauthenticated', 401, 'Authentication required');
  }
  return value;
}

function clientMeta(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: normaliseIp(req.ip),
    userAgent: req.get('user-agent') ?? null,
  };
}

function publicUser(user: AuthContext['user']): Record<string, unknown> {
  return {
    id: user.id,
    displayName: user.displayName,
    role: user.role,
    identityStatus: user.identityStatus,
    primaryEmail: user.primaryEmail,
    primaryPhone: user.primaryPhone,
  };
}

export function createAuthRouter(options: AuthRouterOptions): express.Router {
  const { service, security, env } = options;
  const cookiePolicy: CookiePolicy = { isProduction: env.NODE_ENV === 'production' };
  const router = express.Router();
  const auth = requireAuth(service);

  router.post(
    '/signup',
    validateBody(signupSchema),
    wrap(async (req, res) => {
      const body = req.body as SignupBody;
      const meta = clientMeta(req);
      const result = await service.signup({ ...body, ...meta });
      res.status(201).json({ userId: result.userId, identityStatus: result.identityStatus });
    })
  );

  router.post(
    '/login',
    loginRateLimit(security),
    validateBody(loginSchema),
    wrap(async (req, res) => {
      const body = req.body as LoginBody;
      const meta = clientMeta(req);
      const { tokens, user } = await service.login({ ...body, ...meta });
      setSessionCookies(res, tokens, cookiePolicy);
      res.status(200).json({
        user: {
          id: user.id,
          displayName: user.displayName,
          role: user.role,
          identityStatus: user.identityStatus,
          primaryEmail: user.primaryEmail,
          primaryPhone: user.primaryPhone,
        },
      });
    })
  );

  router.get(
    '/me',
    auth,
    requireOwner(),
    wrap(async (_req, res) => {
      res.status(200).json({ user: publicUser(context(res).user) });
    })
  );

  router.post(
    '/refresh',
    wrap(async (req, res) => {
      const refreshToken = parse(req.headers.cookie ?? '')[REFRESH_COOKIE];
      if (refreshToken === undefined) {
        throw new AuthError('unauthenticated', 401, 'Refresh token missing');
      }
      const tokens = await service.refresh(refreshToken);
      setSessionCookies(res, tokens, cookiePolicy);
      res.status(200).json({ rotated: true });
    })
  );

  router.post(
    '/logout',
    auth,
    wrap(async (_req, res) => {
      const current = context(res);
      await service.logout(current.sessionId, current.user.id);
      clearSessionCookies(res, cookiePolicy);
      res.status(200).json({ loggedOut: true });
    })
  );

  router.post(
    '/password/change',
    auth,
    requireOwner(),
    validateBody(passwordChangeSchema),
    wrap(async (req, res) => {
      const body = req.body as PasswordChangeBody;
      const current = context(res);
      await service.changePassword(
        current.user.id,
        body.currentPassword,
        body.newPassword,
        current.sessionId,
        clientMeta(req).ip
      );
      res.status(200).json({ changed: true });
    })
  );

  router.post(
    '/password/recovery/request',
    recoveryRateLimit(security),
    validateBody(recoveryRequestSchema),
    wrap(async (req, res) => {
      const body = req.body as RecoveryRequestBody;
      await service.requestPasswordRecovery(body.identifier, clientMeta(req).ip);
      // Deliberately identical for existing and non-existing accounts.
      res.status(202).json({
        accepted: true,
        message: 'If the account exists, a recovery request has been recorded.',
      });
    })
  );

  router.post(
    '/password/recovery/confirm',
    validateBody(recoveryConfirmSchema),
    wrap(async (req, res) => {
      const body = req.body as RecoveryConfirmBody;
      await service.confirmPasswordReset(body.token, body.newPassword);
      res.status(200).json({ reset: true });
    })
  );

  router.get(
    '/sessions',
    auth,
    requireOwner(),
    requireVerified(),
    wrap(async (_req, res) => {
      const sessions = await service.listSessions(context(res).user.id);
      res.status(200).json({ sessions });
    })
  );

  router.post(
    '/sessions/:id/revoke',
    auth,
    requireOwner(),
    requireVerified(),
    wrap(async (req, res) => {
      const sessionId = parseWith(uuidParamSchema, req.params.id);
      const revoked = await service.revokeSession(context(res).user.id, sessionId);
      res.status(200).json({ revoked });
    })
  );

  router.post(
    '/admin/identity-verifications/:userId/verify',
    auth,
    requirePlatformAdmin(),
    validateBody(adminVerifySchema),
    wrap(async (req, res) => {
      const body = req.body as AdminVerifyBody;
      const targetUserId = parseWith(uuidParamSchema, req.params.userId);
      const result = await service.verifyIdentity({
        actorUserId: context(res).user.id,
        targetUserId,
        decision: body.decision,
        evidence: body.evidence,
        notes: body.notes,
        actorIp: clientMeta(req).ip,
      });
      res.status(200).json({ ...result, mechanism: service.verificationMechanism });
    })
  );

  router.post(
    '/admin/password-reset/:userId',
    auth,
    requirePlatformAdmin(),
    validateBody(adminResetSchema),
    wrap(async (req, res) => {
      const body = req.body as AdminResetBody;
      const targetUserId = parseWith(uuidParamSchema, req.params.userId);
      const resetToken = await service.adminIssueResetToken(
        context(res).user.id,
        targetUserId,
        body.evidence,
        clientMeta(req).ip
      );
      // Operator handoff only. No SMS/email integration is implied or implemented.
      res.status(200).json({ resetToken, delivery: 'admin_assisted_out_of_band' });
    })
  );

  return router;
}
