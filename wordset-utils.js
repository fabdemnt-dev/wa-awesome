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

// idからアイコンを探す。見つからなければnullを返す
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

// パスワードをそのまま保存しないための簡易ハッシュ（※本格的な暗号強度はない、簡易な難読化）
export function simpleHash(str) {
  let hash = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    hash = (Math.imul(31, hash) + s.charCodeAt(i)) | 0;
  }
  return "h" + (hash >>> 0).toString(36);
}
