import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { HttpError, requireCondition } from './storage.js';

const deriveKey = promisify(scrypt);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await deriveKey(password, salt, 64);
  return salt + ':' + key.toString('hex');
}

export async function verifyPassword(password, storedHash) {
  // Effectuer la même dérivation même si l’adresse n’existe pas.
  const [salt, hex] = (storedHash ?? '00000000000000000000000000000000:' + '00'.repeat(64)).split(':');
  const key = await deriveKey(password, salt, 64);
  return timingSafeEqual(Buffer.from(hex, 'hex'), key) && Boolean(storedHash);
}

export function tokenFor(user, secret) {
  return jwt.sign({ rev: user.authVersion }, secret, {
    algorithm: 'HS256', subject: user._id, issuer: 'social-networks-api',
    audience: 'social-networks-api', expiresIn: '2h'
  });
}

export function identify(users, secret) {
  return async (req, _res, next) => {
    const authorization = req.get('authorization');
    if (!authorization) return next();
    const token = /^Bearer (\S+)$/i.exec(authorization)?.[1];
    let claims;
    try {
      claims = jwt.verify(token, secret, {
        algorithms: ['HS256'], issuer: 'social-networks-api', audience: 'social-networks-api'
      });
    } catch {
      throw new HttpError(401, 'Jeton invalide ou expiré');
    }
    req.user = await users.findOne({ _id: claims.sub, authVersion: claims.rev, deletedAt: null });
    requireCondition(req.user, 401, 'Jeton invalide ou expiré');
    next();
  };
}
