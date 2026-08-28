import state from './haiku-state.js';
import { evalOptionsMaster } from './haiku-utils.js';
import { getParticipantNameByUid } from './participant-utils.js';

function displayName(data, key) {
  return getParticipantNameByUid(data, key) || key;
}

function buildHistory() {
  const exportAll = document.getElementById('export-all-check')?.checked ?? true;
  const historyToExport = exportAll ? [...(state.currentData.history || [])] : [];
  const currentPhrases = state.currentData.phrases || {};
  if (Object.keys(currentPhrases).length > 0) {
    const players = state.currentData.players || [];
    const currentHost = players.includes(state.currentData.currentHost) ? state.currentData.currentHost : (players[0] || '未設定');
    historyToExport.push({
      round: state.currentData.roundCount || 1,
      host: currentHost,
      phrases: currentPhrases,
      votes: state.currentData.votes || {},
      participantUids: state.currentData.participantUids || {},
      roundPlayerUids: state.currentData.roundPlayerUids || [],
      roundPlayerNames: state.currentData.roundPlayerNames || {},
    });
  }
  return historyToExport;
}

function voteEntries(history, targetKey, targetName) {
  const entries = [];
  Object.keys(history.votes || {}).forEach(voterKey => {
    const voterName = displayName(history, voterKey);
    const vData = history.votes[voterKey]?.[targetKey] ?? history.votes[voterKey]?.[targetName];
    if (!vData) return;
    const keys = Array.isArray(vData) ? vData : [vData];
    keys.forEach(k => {
      if (evalOptionsMaster[k]) entries.push({ voterName, option: evalOptionsMaster[k] });
    });
  });
  return entries;
}

window.exportText = function() {
  if (!state.currentData) return;
  const historyToExport = buildHistory();
  if (historyToExport.length === 0) return alert('出力する記録がありません');

  let txt = `【わ〜鯖句会 記録】\n\n`;
  historyToExport.forEach(h => {
    txt += `--- 第${h.round}節 (選者: ${h.host}) ---\n`;
    Object.keys(h.phrases || {}).forEach(p => {
      const pName = displayName(h, p);
      txt += `[句] ${pName}: ${h.phrases[p]}\n`;
      const voteStrs = voteEntries(h, p, pName).map(({ voterName, option }) => `${voterName}：${option.label}`);
      txt += voteStrs.length > 0 ? `   └ 御印 → ${voteStrs.join(', ')}\n` : '   └ 御印 → なし\n';
    });
    txt += '\n';
  });
  navigator.clipboard.writeText(txt).then(() => {
    alert('Discord用のテキストをクリップボードにコピーしました！');
  }).catch(e => alert('コピーに失敗しました: ' + e));
};

window.exportCSV = function() {
  if (!state.currentData) return;
  const historyToExport = buildHistory();
  if (historyToExport.length === 0) return alert('出力する記録がありません');

  let csv = `節,選者,風流名,句,贈られた御印\n`;
  historyToExport.forEach(h => {
    Object.keys(h.phrases || {}).forEach(p => {
      const pName = displayName(h, p);
      const phraseText = h.phrases[p] || '';
      const voteLabels = voteEntries(h, p, pName).map(({ voterName, option }) => {
        const cleanLabel = option.label.replace(option.icon, '').trim();
        return `${voterName}(${cleanLabel})`;
      });
      csv += `${h.round},"${h.host}","${pName}","${phraseText}","${voteLabels.join(' / ')}"\n`;
    });
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `haiku_${state.roomId}.csv`;
  a.click();
};
