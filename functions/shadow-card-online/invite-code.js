'use strict';

const crypto = require('node:crypto');
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomPart(length) {
  return Array.from({ length }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
}

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replaceAll('I', '1').replaceAll('L', '1').replaceAll('O', '0');
}

function createInviteCode() {
  const locator = randomPart(6);
  const secret = randomPart(10);
  return { locator, secret, code: `SC2-${locator}-${secret}` };
}

function parseInviteCode(value) {
  const normalized = normalizeCode(value);
  if (!/^SC2[0-9A-HJKMNP-TV-Z]{16}$/.test(normalized)) return null;
  return { locator: normalized.slice(3, 9), secret: normalized.slice(9) };
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
