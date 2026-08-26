import { getParticipantStorageKey } from './participant-utils.js';

// 手札サブコレクションを使う新形式かどうかを判定する。
// schemaVersionがない既存ルームは必ず旧形式として扱う。
export function usesHandSubcollection(data) {
  return data?.schemaVersion === 2;
}

// 新形式へ移行する前のルームから、表示名キーまたはUIDキーの手札を読む。
// この関数は読み取り専用で、Firestoreへの書き込みは行わない。
export function getLegacyHaikuHand(data, type, uid, name) {
  if (type !== 5 && type !== 7) return [];
  const hands = type === 5 ? data?.hands5 : data?.hands7;
  if (!hands || typeof hands !== 'object' || Array.isArray(hands)) return [];
  const key = getParticipantStorageKey(data, uid, name);
  return Array.isArray(hands[key]) ? hands[key] : [];
}

// FirestoreのhandsサブコレクションのドキュメントIDとして使えるUIDだけを受け付ける。
export function requireHandUid(uid) {
  const value = String(uid ?? '');
  if (!value || value.includes('/') || value === '.' || value === '..') {
    throw new Error('手札UIDが不正です。');
  }
  return value;
}
