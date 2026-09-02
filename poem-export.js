import { getParticipantNameByUid } from './participant-utils.js';

function displayName(data, key) {
  return getParticipantNameByUid(data, key) || key;
}

function buildHistory(currentData, exportAll) {
  const historyToExport = exportAll ? [...(currentData.history || [])] : [];
  const currentPoems = currentData.poems || {};
  if (Object.keys(currentPoems).length > 0) {
    historyToExport.push({
      round: currentData.roundCount || 1,
      poems: currentPoems,
      participantUids: currentData.participantUids || {}
    });
  }
  return historyToExport;
}

export function exportPoemText(currentData, exportAll = true) {
  if (!currentData) return;
  const historyToExport = buildHistory(currentData, exportAll);
  if (historyToExport.length === 0) return alert('出力するポエムがありません');

  let text = `【わ〜鯖せーへきポエム 作品集】\n\n`;
  historyToExport.forEach(h => {
    text += `--- 第${h.round}幕 ---\n`;
    Object.keys(h.poems || {}).forEach(poemKey => {
      const poemData = h.poems[poemKey];
      const poemText = typeof poemData === 'object' ? poemData.text : poemData;
      text += `■ ${displayName(h, poemKey)} の作品\n   「${poemText}」\n\n`;
    });
  });

  return navigator.clipboard.writeText(text).then(() => {
    alert('Discord用のテキストをクリップボードにコピーしました！');
  }).catch(e => alert('コピーに失敗しました: ' + e));
}

export function exportPoemCSV(currentData, roomId, exportAll = true) {
  if (!currentData) return;
  const historyToExport = buildHistory(currentData, exportAll);
  if (historyToExport.length === 0) return alert('出力するポエムがありません');

  const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  let csvContent = "\uFEFF";
  csvContent += "幕,作者,作品\n";
  historyToExport.forEach(h => {
    Object.keys(h.poems || {}).forEach(poemKey => {
      const poemData = h.poems[poemKey];
      const poemText = typeof poemData === 'object' ? poemData.text : poemData;
      csvContent += [h.round, displayName(h, poemKey), poemText].map(csvCell).join(',') + '\n';
    });
  });

  const url = URL.createObjectURL(new Blob([csvContent], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", `poem_result_room_${roomId}.csv`);
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    document.body.removeChild(link);
    // ダウンロード開始後に一時URLを解放する。
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
