import { evalOptionsMaster } from "./eval.js";

export function exportText(currentData) {
  if (!currentData) return;
  const history = currentData.history || [];
  const currentPhrases = currentData.phrases || {};
  const currentDetails = currentData.phraseDetails || {};
  const currentVotes = currentData.votes || {};
  const currentRound = currentData.roundCount || 1;

  let text = `【わ〜鯖せーへきはぃく 履歴一覧】\n\n`;

  const formatRoundText = (rNum, rHost, rPhrases, rDetails, rVotes) => {
    let block = `━━━ 第 ${rNum} 節 (選者: ${rHost}) ━━━\n`;
    Object.keys(rPhrases).forEach(pName => {
      const details = rDetails[pName] || [];
      let phraseStr = rPhrases[pName];
      if (details.length === 3) {
        phraseStr = details.map(d => `${d.text}(${d.author})`).join(" ");
      }

      let evalStr = "";
      Object.keys(rVotes).forEach(voter => {
        const vKey = rVotes[voter] ? rVotes[voter][pName] : null;
        if (vKey && evalOptionsMaster[vKey]) {
          evalStr += ` [${evalOptionsMaster[vKey].icon}${voter}]`;
        }
      });

      block += `・${pName}: ${phraseStr}${evalStr}\n`;
    });
    return block + `\n`;
  };

  history.forEach(h => {
    text += formatRoundText(h.round, h.host, h.phrases || {}, h.phraseDetails || {}, h.votes || {});
  });

  if (Object.keys(currentPhrases).length > 0) {
    const players = currentData.players || [];
    const hostIndex = currentData.hostIndex || 0;
    const curHost = players[hostIndex % (players.length || 1)] || '';
    text += formatRoundText(currentRound, curHost, currentPhrases, currentDetails, currentVotes);
  }

  navigator.clipboard.writeText(text).then(() => {
    alert("Discord用テキストをクリップボードにコピーしました！");
  }).catch(err => {
    console.error(err);
    alert("コピーに失敗しました");
  });
}

export function exportCSV(currentData, roomId) {
  if (!currentData) return;
  const history = currentData.history || [];
  const currentPhrases = currentData.phrases || {};
  const currentDetails = currentData.phraseDetails || {};
  const currentVotes = currentData.votes || {};
  const currentRound = currentData.roundCount || 1;

  let csv = "\uFEFF第何節,選者(親),詠み手,完成はぃく,構成要素(素材と作者),獲得評価\n";

  const processRow = (rNum, rHost, pName, fullText, details, rVotes) => {
    const safeText = `"${(fullText || "").replace(/"/g, '""')}"`;
    const wordsStr = details.length === 3
      ? `"${details.map(d => `${d.text}(${d.author})`).join(" ")}"`
      : safeText;

    let evalList = [];
    Object.keys(rVotes).forEach(voter => {
      const vKey = rVotes[voter] ? rVotes[voter][pName] : null;
      if (vKey && evalOptionsMaster[vKey]) {
        evalList.push(`${evalOptionsMaster[vKey].label}(${voter})`);
      }
    });
    const evalStr = `"${evalList.join(" / ")}"`;

    return `${rNum},"${rHost}","${pName}",${safeText},${wordsStr},${evalStr}\n`;
  };

  history.forEach(h => {
    const rPhrases = h.phrases || {};
    const rDetails = h.phraseDetails || {};
    const rVotes = h.votes || {};
    Object.keys(rPhrases).forEach(pName => {
      csv += processRow(h.round, h.host, pName, rPhrases[pName], rDetails[pName] || [], rVotes);
    });
  });

  if (Object.keys(currentPhrases).length > 0) {
    const players = currentData.players || [];
    const hostIndex = currentData.hostIndex || 0;
    const curHost = players[hostIndex % (players.length || 1)] || '';
    Object.keys(currentPhrases).forEach(pName => {
      csv += processRow(currentRound, curHost, pName, currentPhrases[pName], currentDetails[pName] || [], currentVotes);
    });
  }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `haiku_history_${roomId}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
