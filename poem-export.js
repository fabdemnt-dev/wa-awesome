export function exportPoemText(currentData) {
  if (!currentData || !currentData.poems || Object.keys(currentData.poems).length === 0) {
    return alert('出力するポエムがありません');
  }

  let text = `【わ〜鯖せーへきポエム 作品集】\n\n`;
  Object.keys(currentData.poems).forEach(pName => {
    text += `■ ${pName} の作品\n`;
    text += `   「${currentData.poems[pName]}」\n\n`;
  });

  navigator.clipboard.writeText(text).then(() => {
    alert('Discord用のテキストをクリップボードにコピーしました！');
  }).catch(e => alert('コピーに失敗しました: ' + e));
}

export function exportPoemCSV(currentData, roomId) {
  if (!currentData || !currentData.poems || Object.keys(currentData.poems).length === 0) {
    return alert('出力するポエムがありません');
  }

  let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
  csvContent += "作者,作品\n";

  Object.keys(currentData.poems).forEach(pName => {
    const poemText = currentData.poems[pName] || "";
    csvContent += `"${pName}","${poemText}"\n`;
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `poem_result_room_${roomId}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
