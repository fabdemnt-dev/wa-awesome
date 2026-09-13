'use strict';

const crypto = require('node:crypto');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function normalizeCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replaceAll('I', '1')
    .replaceAll('L', '1')
    .replaceAll('O', '0');
}

function charsFromDigest(buffer, length) {
  let output = '';
  for (let index = 0; output.length < length; index += 1) {
    output += ALPHABET[buffer[index % buffer.length] & 31];
  }
  return output;
}

function createInviteCode(uid, requestId, key) {
  const locatorDigest = crypto.createHmac('sha256', key).update(`locator:v1:${uid}:${requestId}`).digest();
  const secretDigest = crypto.createHmac('sha256', key).update(`secret:v1:${uid}:${requestId}`).digest();
  const locator = charsFromDigest(locatorDigest, 6);
  const secret = charsFromDigest(secretDigest, 10);
  return { locator, secret, code: `MSD1-${locator}-${secret}` };
}

function parseInviteCode(value) {
  const normalized = normalizeCode(value);
  if (!/^MSD1[0-9A-HJKMNP-TV-Z]{16}$/.test(normalized)) return null;
  return { locator: normalized.slice(4, 10), secret: normalized.slice(10) };
}

function mac(locator, secret, key) {
  return crypto.createHmac('sha256', key).update(`v1:${locator}:${secret}`).digest('base64url');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function hashIp(ip, key, day = new Date().toISOString().slice(0, 10)) {
  return crypto.createHmac('sha256', key).update(`${day}:${String(ip || 'unknown')}`).digest('base64url');
}

module.exports = { createInviteCode, parseInviteCode, mac, safeEqual, hashIp };
