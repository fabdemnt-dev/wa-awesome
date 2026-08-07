// XSS対策：入力された文字を安全な形式に変換
function escapeHTML(str) {
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

// XSS対策：JSの引数用にエスケープ
function escapeJS(str) {
  if (typeof str !== "string") return "";
  return str.replace(/'/g, "\\'").replace(/"/g, '\\"');
}

// 評価マスタ
const evalOptionsMaster = {
  okashi:   { icon: "🌸", label: "🌸 いとおかし", pts: 1 },
  aware:    { icon: "🌾", label: "🌾 もののあはれ", pts: 1 },
  wabisabi: { icon: "❄️", label: "❄️ わびさび", pts: 1 },
  ayashi:   { icon: "🌀", label: "🌀 あやし", pts: 1 },
  kuruoshi: { icon: "🍶", label: "🍶 狂おし", pts: 1 },
  medurashi:{ icon: "✨", label: "✨ めづらし", pts: 1 },
  yugen:    { icon: "🌙", label: "🌙 幽玄", pts: 1 },
  tae:      { icon: "🪭", label: "🪭 妙なり", pts: 10 },
  // 見学者専用のお楽しみリアクション（得点計算には含めない）
  kanpu:    { icon: "👏", label: "👏 感服つかまつった", pts: 0 }
};

const hostOptionKeys = [
  "okashi",
  "aware",
  "wabisabi",
  "ayashi",
  "kuruoshi",
  "medurashi",
  "yugen",
  "tae"
];

const childOptionKeys = [
  "okashi",
  "aware",
  "wabisabi"
];

const spectatorOptionKeys = [
  "kanpu"
];

const colorPalette = [
  { bg: '#dbeafe', text: '#1e40af', border: '#bfdbfe' },
  { bg: '#fef3c7', text: '#92400e', border: '#fde68a' },
  { bg: '#dcfce7', text: '#166534', border: '#bbf7d0' },
  { bg: '#fce7f3', text: '#9d174d', border: '#fbcfe8' },
  { bg: '#e0e7ff', text: '#3730a3', border: '#c7d2fe' },
  { bg: '#f3e8ff', text: '#6b21a8', border: '#e9d5ff' },
  { bg: '#ffedd5', text: '#9a3412', border: '#fed7aa' },
  { bg: '#cffafe', text: '#155e75', border: '#a5f3fc' }
];

export {
  escapeHTML,
  escapeJS,
  evalOptionsMaster,
  hostOptionKeys,
  childOptionKeys,
  spectatorOptionKeys,
  colorPalette
};
