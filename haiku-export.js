import state from './haiku-state.js';
import { evalOptionsMaster } from './haiku-utils.js';

window.exportText = function() {
  if (!state.currentData) return;
  
  // チェックボックスの状態を取得（見つからなければとりあえず全部出力）
  const exportAll = document.getElementById('export-all-check')?.checked ?? true;
  
  // exportAllがtrueなら過去の履歴を含め、falseなら空にする
  const historyToExport = exportAll ? [...(state.currentData.history || [])] : [];

  // 現在進行中の節（句が1つでも提出されていれば）も出力用データに追加
  const currentPhrases = state.currentData.phrases || {};
  if (Object.keys(currentPhrases).length > 0) {
    const players = state.currentData.players || [];
    const currentHost = players.includes(state.currentData.currentHost) ? state.currentData.currentHost : (players[0] || '未設定');
    historyToExport.push({
      round: state.currentData.roundCount || 1,
      host: currentHost,
      phrases: currentPhrases,
      votes: state.currentData.votes || {}
    });
  }

  if (historyToExport.length === 0) {
    return alert('出力する記録がありません');
  }

  let txt = `【わ〜鯖句会 記録】\n\n`;
  historyToExport.forEach(h => {
    txt += `--- 第${h.round}節 (選者: ${h.host}) ---\n`;
    Object.keys(h.phrases || {}).forEach(p => {
      txt += `[句] ${p}: ${h.phrases[p]}\n`;
      
      let voteStrs = [];
      Object.keys(h.votes || {}).forEach(voter => {
        const vData = h.votes[voter]?.[p];
        if (vData) {
          const keys = Array.isArray(vData) ? vData : [vData];
          keys.forEach(k => {
            if (evalOptionsMaster[k]) {
              voteStrs.push(`${voter}：${evalOptionsMaster[k].label}`);
            }
          });
        }
      });
      if (voteStrs.length > 0) {
        txt += `   └ 御印 → ${voteStrs.join(', ')}\n`;
      } else {
        txt += `   └ 御印 → なし\n`;
      }
    });
    txt += `\n`;
  });

  navigator.clipboard.writeText(txt).then(() => {
    alert('Discord用のテキストをクリップボードにコピーしました！');
  }).catch(e => alert('コピーに失敗しました: ' + e));
};

window.exportCSV = function() {
  if (!state.currentData) return;
  
  const exportAll = document.getElementById('export-all-check')?.checked ?? true;
  const historyToExport = exportAll ? [...(state.currentData.history || [])] : [];

  // 現在進行中の節も追加
  const currentPhrases = state.currentData.phrases || {};
  if (Object.keys(currentPhrases).length > 0) {
    const players = state.currentData.players || [];
    const currentHost = players.includes(state.currentData.currentHost) ? state.currentData.currentHost : (players[0] || '未設定');
    historyToExport.push({
      round: state.currentData.roundCount || 1,
      host: currentHost,
      phrases: currentPhrases,
      votes: state.currentData.votes || {}
    });
  }

  if (historyToExport.length === 0) {
    return alert('出力する記録がありません');
  }

  let csv = `節,選者,風流名,句,贈られた御印\n`;
  historyToExport.forEach(h => {
    Object.keys(h.phrases || {}).forEach(p => {
      const phraseText = h.phrases[p] || '';
      
      let voteLabels = [];
      Object.keys(h.votes || {}).forEach(voter => {
        const vData = h.votes[voter]?.[p];
        if (vData) {
          const keys = Array.isArray(vData) ? vData : [vData];
          keys.forEach(k => {
            if (evalOptionsMaster[k]) {
              const cleanLabel = evalOptionsMaster[k].label.replace(evalOptionsMaster[k].icon, '').trim();
              voteLabels.push(`${voter}(${cleanLabel})`);
            }
          });
        }
      });
      const votesStr = voteLabels.join(' / ');

      csv += `${h.round},"${h.host}","${p}","${phraseText}","${votesStr}"\n`;
    });
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `haiku_${state.roomId}.csv`;
  a.click();
};
