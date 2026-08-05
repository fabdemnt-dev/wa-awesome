export function exportPoemText(currentData, exportAll = true) {
  if (!currentData) return;
  const historyToExport = exportAll ? [...(currentData.history || [])] : [];
  
  const currentPoems = currentData.poems || {};
  if (Object.keys(currentPoems).length > 0) {
    historyToExport.push({
      round: currentData.roundCount || 1,
      poems: currentPoems
    });
  }

  if (historyToExport.length === 0) {
    return alert('出力するポエムがありません');
  }

  let text = `【わ〜鯖せーへきポエム 作品集】\n\n`;
  historyToExport.forEach(h => {
    text += `--- 第${h.round}幕 ---\n`;
    Object.keys(h.poems || {}).forEach(pName => {
      const poemData = h.poems[pName];
      const poemText = typeof poemData === 'object' ? poemData.text : poemData;
      text += `■ ${pName} の作品\n   「${poemText}」\n\n`;
    });
  });

  navigator.clipboard.writeText(text).then(() => {
    alert('Discord用のテキストをクリップボードにコピーしました！');
  }).catch(e => alert('コピーに失敗しました: ' + e));
}

export function exportPoemCSV(currentData, roomId, exportAll = true) {
  if (!currentData) return;
  const historyToExport = exportAll ? [...(currentData.history || [])] : [];
  const currentPoems = currentData.poems || {};

  if (Object.keys(currentPoems).length > 0) {
    historyToExport.push({
      round: currentData.roundCount || 1,
      poems: currentPoems
    });
  }

  if (historyToExport.length === 0) {
    return alert('出力するポエムがありません');
  }

  let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
  csvContent += "幕,作者,作品\n";

  historyToExport.forEach(h => {
    Object.keys(h.poems || {}).forEach(pName => {
      const poemData = h.poems[pName];
      const poemText = typeof poemData === 'object' ? poemData.text : poemData;
      const cleanText = poemText.replace(/"/g, '""');
      csvContent += `${h.round},"${pName}","${cleanText}"\n`;
    });
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `poem_result_room_${roomId}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
