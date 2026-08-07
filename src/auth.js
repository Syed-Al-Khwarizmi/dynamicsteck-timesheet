import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/**
 * Password hashing with Node's built-in scrypt. No dependency and no native
 * build, which matters on Windows where bcrypt and argon2 both want a C++
 * toolchain. scrypt is memory-hard and a legitimate choice for this.
 *
 * Stored format: scrypt$N$salt$hash, so the cost can be raised later without
 * invalidating existing hashes.
 */
const COST = 16384; // 2^14, OWASP's minimum N for scrypt
const KEYLEN = 64;

export async function hashPassword(plain) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(plain, salt, KEYLEN, { N: COST, r: 8, p: 1 });
  return `scrypt$${COST}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(plain, stored) {
  if (!stored) return false;
  const [scheme, cost, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  try {
    const derived = await scryptAsync(plain, Buffer.from(salt, 'base64'), KEYLEN, {
      N: Number(cost),
      r: 8,
      p: 1,
    });
    const expected = Buffer.from(hash, 'base64');
    // Equal lengths by construction, but guard anyway: timingSafeEqual throws
    // on a mismatch and the throw would itself leak information.
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export const newSessionToken = () => randomBytes(32).toString('base64url');

/** Only the hash is stored, so a leaked database cannot be used to sign in. */
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

/** Readable but not guessable, for handing a new account its first password. */
export function suggestPassword() {
  return `${randomBytes(6).toString('base64url')}-${randomBytes(3).toString('base64url')}`;
}
