'use strict';
const crypto = require('node:crypto');
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const chars = (buffer, length) => Array.from({ length }, (_, i) => ALPHABET[buffer[i % buffer.length] & 31]).join('');
function createInviteCode(uid, requestId, key) { const locator = chars(crypto.createHmac('sha256', key).update(`dma-l:${uid}:${requestId}`).digest(), 6); const secret = chars(crypto.createHmac('sha256', key).update(`dma-s:${uid}:${requestId}`).digest(), 10); return { locator, secret, code: `DMA1-${locator}-${secret}` }; }
function parseInviteCode(value) { const normalized = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replaceAll('I', '1').replaceAll('L', '1').replaceAll('O', '0'); return /^DMA1[0-9A-HJKMNP-TV-Z]{16}$/.test(normalized) ? { locator: normalized.slice(4, 10), secret: normalized.slice(10) } : null; }
function mac(locator, secret, key) { return crypto.createHmac('sha256', key).update(`dma:v1:${locator}:${secret}`).digest('base64url'); }
function safeEqual(a, b) { const left = Buffer.from(String(a)); const right = Buffer.from(String(b)); return left.length === right.length && crypto.timingSafeEqual(left, right); }
module.exports = { createInviteCode, parseInviteCode, mac, safeEqual };
