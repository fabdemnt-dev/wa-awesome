'use strict';
const crypto = require('node:crypto');
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SECRET_NAME = 'FLOATING_GARDEN_INVITE_HMAC_KEY';
const EMULATOR_ONLY_KEY = 'floating-garden-demo-emulator-only-key-not-for-production';
function isDemoEmulator(env = process.env) { return env.FUNCTIONS_EMULATOR === 'true' && Boolean(env.FIRESTORE_EMULATOR_HOST) && /^demo-/.test(env.GCLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT || ''); }
function requireInviteHmacKey(readSecret, env = process.env) {
  let value;
  try { value = readSecret(); } catch { /* Fail closed unless every explicit demo-emulator gate is present. */ }
  if (!value && isDemoEmulator(env)) value = EMULATOR_ONLY_KEY;
  if (typeof value !== 'string' || value.length < 32) throw new Error(`${SECRET_NAME} must be configured with at least 32 characters`);
  return value;
}
function digestChars(key, input, length) {
  const digest = crypto.createHmac('sha256', key).update(input).digest();
  return Array.from(digest.subarray(0, length), (byte) => ALPHABET[byte & 31]).join('');
}
function createInviteCode(uid, requestId, key) {
  const identity = JSON.stringify([uid, requestId]);
  const locator = digestChars(key, `floating-garden:locator:v1:${identity}`, 8);
  const secret = digestChars(key, `floating-garden:invite:v1:${identity}`, 16);
  return { locator, secret, code: `FG1-${locator}-${secret}` };
}
function parseInviteCode(value) {
  if (typeof value !== 'string' || value.length > 80) return null;
  const normalized = value.trim().toUpperCase().replace(/[ -]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (!/^FG1[0-9A-HJKMNP-TV-Z]{24}$/.test(normalized)) return null;
  return { locator: normalized.slice(3, 11), secret: normalized.slice(11) };
}
function inviteMac(locator, secret, key) { return crypto.createHmac('sha256', key).update(`floating-garden:verify:v1:${locator}:${secret}`).digest('hex'); }
function safeEqual(a, b) { if (typeof a !== 'string' || typeof b !== 'string') return false; const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && crypto.timingSafeEqual(left, right); }
function hashIp(ip, key) { return crypto.createHmac('sha256', key).update(`floating-garden:ip:v1:${ip}`).digest('hex'); }
module.exports = { isDemoEmulator, SECRET_NAME, EMULATOR_ONLY_KEY, requireInviteHmacKey, createInviteCode, parseInviteCode, inviteMac, safeEqual, hashIp };
