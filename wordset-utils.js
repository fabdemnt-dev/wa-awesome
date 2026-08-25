// XSS対策：入力された文字を安全な形式に変換
export function escapeHTML(str) {
  if (typeof str !== "string") return "";
  return str.replace(/[&'`"<>]/g, function (match) {
    return {
      "&": "&amp;",
      "'": "&#x27;",
      "`": "&#x60;",
      '"': "&quot;",
      "<": "&lt;",
      ">": "&gt;",
    }[match];
  });
}

// 改行だけで区切って、ことばの配列にする（1行=1つのことばとしてそのまま使う）
// ※スペースや「・」「、」なども中身の一部として扱いたい場合があるため、改行以外では区切らない
export function splitWords(text) {
  return (text || "")
    .split(/\r\n|\r|\n/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

// 永続化するワードセットは文字列配列を正規形とする。
// 旧版のゲーム保存では { text, author, id } 形式が保存されていたため、読み込み時に文字列へ戻す。
function normalizeWord(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value.text === 'string') return value.text.trim();
  return '';
}

export function normalizeWordList(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map(normalizeWord)
    .filter((value) => value.length > 0);
}

export function normalizeWordSet(wordSet) {
  const normalized = { ...wordSet };

  if (wordSet?.type === 'haiku') {
    normalized.words5 = normalizeWordList(wordSet.words5);
    normalized.words7 = normalizeWordList(wordSet.words7);
  } else if (wordSet?.type === 'poem') {
    normalized.words = normalizeWordList(wordSet.words);
  }

  return normalized;
}

// アイコンの選択肢一覧（フォームでユーザーが自分で選べる）
export const iconPalette = [
  { id: "heart", emoji: "💗", bg: "#fce7f3" },
  { id: "sun", emoji: "☀️", bg: "#fef9c3" },
  { id: "moon", emoji: "🌙", bg: "#e0e7ff" },
  { id: "game", emoji: "🎮", bg: "#dcfce7" },
  { id: "star", emoji: "⭐", bg: "#fef3c7" },
  { id: "clover", emoji: "🍀", bg: "#dcfce7" },
  { id: "wave", emoji: "🌊", bg: "#dbeafe" },
  { id: "fire", emoji: "🔥", bg: "#fee2e2" },
  { id: "book", emoji: "📗", bg: "#e0f2fe" },
  { id: "bamboo", emoji: "🎋", bg: "#ecfccb" },
  { id: "music", emoji: "🎵", bg: "#ede9fe" },
  { id: "sparkle", emoji: "✨", bg: "#fdf4ff" },
];

// 保存する自由入力アイコンは短いテキストだけに制限する。
// 実際の描画時にもescapeHTMLを通すため、HTMLとして解釈されることはない。
export function normalizeIcon(value) {
  if (typeof value !== 'string') return null;
  const icon = Array.from(value.trim()).slice(0, 4).join('');
  return icon || null;
}

// idからアイコンを探す。見つからなければnullを返す（過去にボタン選択式で保存された分の互換用）
export function getIconById(id) {
  return iconPalette.find((icon) => icon.id === id) || null;
}

// アイコンを選んでいない古いセットのために、名前(ID)からそれっぽく自動で選ぶフォールバック
export function iconForId(id) {
  let hash = 0;
  const str = String(id || "");
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return iconPalette[hash % iconPalette.length];
}

// 自分で入力した絵文字アイコン用に、背景色だけIDから自動で選ぶ
const bgPalette = iconPalette.map((icon) => icon.bg);
export function bgForId(id) {
  let hash = 0;
  const str = String(id || "");
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 17 + str.charCodeAt(i)) >>> 0;
  }
  return bgPalette[hash % bgPalette.length];
}

// パスワードをそのまま保存しないための簡易ハッシュ（※本格的な暗号強度はない、簡易な難読化）
export function simpleHash(str) {
  let hash = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    hash = (Math.imul(31, hash) + s.charCodeAt(i)) | 0;
  }
  return "h" + (hash >>> 0).toString(36);
}
