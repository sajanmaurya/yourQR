import { clerkMiddleware, getAuth, createClerkClient } from '@clerk/express';
import { randomBytes } from 'node:crypto';
import { dbGet, dbRun, verifyPassword } from './database.js';
import { ValidationError } from './qr.js';

// External identities point to existing numeric workspace owners. No QR/file IDs move.
export function createClerkAuth({ db, publishableKey, secretKey, authorizedParties, adapter }) {
  const client = adapter || createClerkClient({ publishableKey, secretKey });
  const middleware = adapter?.middleware || clerkMiddleware({ publishableKey, secretKey, authorizedParties });
  const auth = adapter?.getAuth || getAuth;
  const findUser = id => dbGet(db, 'SELECT users.* FROM users JOIN clerk_identities c ON c.user_id=users.id WHERE c.clerk_id=?', [id]);
  async function verifiedProfile(id) {
    const profile = await client.users.getUser(id);
    const primary = profile.emailAddresses.find(email => email.id === profile.primaryEmailAddressId);
    if (primary?.verification?.status !== 'verified') throw new ValidationError('Verify your email address in Clerk before opening your workspace.', 403);
    return { email: primary.emailAddress.toLowerCase(), name: (profile.fullName || profile.firstName || primary.emailAddress.split('@')[0]).slice(0, 80) };
  }
  async function bind(id, userId) {
    await dbRun(db, 'INSERT INTO clerk_identities(clerk_id,user_id) VALUES (?,?) ON CONFLICT DO NOTHING', [id, userId]);
    const user = await findUser(id);
    if (!user || Number(user.id) !== Number(userId)) throw new ValidationError('This workspace is already linked to another Clerk account. Contact the administrator.', 409);
    await dbRun(db, 'DELETE FROM user_sessions WHERE user_id=?', [userId]);
    return user;
  }
  return {
    middleware,
    async resolve(req) {
      const { userId } = auth(req);
      if (!userId) return;
      req.clerkUserId = userId;
      let user = await findUser(userId);
      if (!user) {
        const profile = await verifiedProfile(userId);
        const existing = await dbGet(db, 'SELECT id FROM users WHERE lower(email)=?', [profile.email]);
        if (existing) { req.clerkLinkRequired = true; return; }
        // Clerk owns credentials; this random non-scrypt value cannot log in locally.
        const created = await dbGet(db, 'INSERT INTO users(name,email,password_hash,created_at) VALUES (?,?,?,?) ON CONFLICT DO NOTHING RETURNING id', [profile.name, profile.email, `clerk:${randomBytes(32).toString('hex')}`, new Date().toISOString()]);
        if (created) user = await bind(userId, created.id);
        else user = await findUser(userId);
        if (!user) { req.clerkLinkRequired = true; return; }
      }
      req.user = { id: Number(user.id), name: user.name, email: user.email };
    },
    async link(req) {
      if (!req.clerkUserId) throw new ValidationError('Sign in with Clerk first.', 401);
      const profile = await verifiedProfile(req.clerkUserId);
      const user = await dbGet(db, 'SELECT * FROM users WHERE lower(email)=?', [profile.email]);
      const password = req.body?.password;
      if (!user || typeof password !== 'string' || password.length > 256 || !await verifyPassword(password, user.password_hash)) throw new ValidationError('Your existing yourQR password is incorrect.', 401);
      await bind(req.clerkUserId, user.id);
      return { id: Number(user.id), name: user.name, email: user.email };
    },
  };
}
