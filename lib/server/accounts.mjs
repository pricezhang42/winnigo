import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { database } from './postgres.mjs';
import { readConfig } from './config.mjs';
import { sendAccountMail } from './account-mail.mjs';

let instance;

/**
 * Better Auth configured for Winnigo: invitation-only email/password (verified email required),
 * optional Google sign-in, PostgreSQL-backed sessions and rate limits, and security audit rows.
 * Roles and the enabled flag live in `user_access`, outside Better Auth.
 */
export function createAccounts({
  pool = database(),
  env = process.env,
  sendMail = sendAccountMail,
} = {}) {
  const { origin } = readConfig(env);
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw Error('Configure a random BETTER_AUTH_SECRET of at least 32 characters');
  const audit = async (action, userId) =>
    pool.query('INSERT INTO security_audit(action,user_id) VALUES($1,$2)', [action, userId]);
  // The owner must transfer ownership first, so there is always exactly one owner.
  const refuseOwnerDeletion = async (user) => {
    const access = await pool.query('SELECT role FROM user_access WHERE user_id=$1', [user.id]);
    if (access.rows[0]?.role === 'owner')
      throw new APIError('FORBIDDEN', {
        message: 'Transfer ownership before deleting the owner account.',
      });
  };
  return betterAuth({
    appName: 'Winnigo',
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    database: pool,
    logger: { disabled: true },
    trustedOrigins: [origin],
    user: {
      modelName: 'auth_user',
      deleteUser: {
        enabled: true,
        sendDeleteAccountVerification: async ({ user, url }) => {
          await refuseOwnerDeletion(user);
          await sendMail({ to: user.email, url, kind: 'delete' }, env);
        },
        beforeDelete: refuseOwnerDeletion,
        afterDelete: async (user) => {
          await pool.query('DELETE FROM account_invitations WHERE email=$1', [
            user.email.toLowerCase(),
          ]);
          await audit('account.deleted', null);
        },
      },
    },
    account: {
      modelName: 'auth_account',
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
    },
    verification: { modelName: 'auth_verification' },
    session: {
      modelName: 'auth_session',
      expiresIn: 7 * 86400, // seconds: one week
      updateAge: 86400, // extend the session at most once a day
      freshAge: 3600, // sensitive actions need a sign-in within the last hour
      cookieCache: { enabled: false },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      autoSignIn: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) =>
        sendMail({ to: user.email, url, kind: 'reset' }, env),
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) =>
        sendMail({ to: user.email, url, kind: 'verify' }, env),
    },
    socialProviders:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
        : {},
    rateLimit: {
      enabled: true,
      storage: 'database',
      modelName: 'auth_rate_limit',
      window: 60,
      max: 60,
    },
    advanced: {
      useSecureCookies: origin.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      ipAddress: { ipAddressHeaders: [] },
    },
    databaseHooks: {
      user: {
        create: {
          // Registration requires an unexpired invitation for the (lower-cased) email.
          before: async (user) => {
            const invited = await pool.query(
              'SELECT 1 FROM account_invitations WHERE email=$1 AND expires_at>now()',
              [user.email.toLowerCase()],
            );
            if (!invited.rowCount)
              throw new APIError('FORBIDDEN', {
                message: 'An invitation is required to join Winnigo.',
              });
            return { data: { ...user, email: user.email.toLowerCase() } };
          },
          after: async (user) => {
            await pool.query('INSERT INTO user_access(user_id) VALUES($1) ON CONFLICT DO NOTHING', [
              user.id,
            ]);
            await audit('account.created', user.id);
          },
        },
      },
      session: {
        create: {
          // Disabled or unverified accounts cannot start a session by any sign-in method.
          before: async (session) => {
            const result = await pool.query(
              'SELECT a.enabled,u."emailVerified" FROM user_access a JOIN auth_user u ON u.id=a.user_id WHERE a.user_id=$1',
              [session.userId],
            );
            if (!result.rows[0]?.enabled || !result.rows[0].emailVerified)
              throw new APIError('FORBIDDEN', { message: 'Verify your email before signing in.' });
          },
          after: async (session) => audit('session.created', session.userId),
        },
        delete: { after: async (session) => audit('session.revoked', session.userId) },
      },
    },
  });
}
/** The shared Better Auth instance for this process. */
export function accounts() {
  return (instance ??= createAccounts());
}
