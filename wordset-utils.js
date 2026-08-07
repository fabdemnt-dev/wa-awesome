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

// 改行・スペース（全角含む）・、。・，で区切って、ことばの配列にする
export function splitWords(text) {
  return (text || "")
    .split(/[\n\r、。・,]+|\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

// 保存済みセットの見た目をランダムっぽく、でもID固定で毎回同じアイコンにする
const iconPalette = [
  { emoji: "💗", bg: "#fce7f3" },
  { emoji: "☀️", bg: "#fef9c3" },
  { emoji: "🌙", bg: "#e0e7ff" },
  { emoji: "🎮", bg: "#dcfce7" },
  { emoji: "⭐", bg: "#fef3c7" },
  { emoji: "🍀", bg: "#dcfce7" },
  { emoji: "🌊", bg: "#dbeafe" },
  { emoji: "🔥", bg: "#fee2e2" },
  { emoji: "📗", bg: "#e0f2fe" },
  { emoji: "🎋", bg: "#ecfccb" },
];

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
