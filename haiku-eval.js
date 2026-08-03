// 評価マスターデータ
export const evalOptionsMaster = {
  okashi: { icon: "🌸", label: "🌸 いとおかし", pts: 1 },
  aware:  { icon: "🌾", label: "🌾 もののあはれ", pts: 1 },
  wabisabi:{ icon: "❄️", label: "❄️ わびさび", pts: 1 },
  ayashi: { icon: "🌀", label: "🌀 あやし", pts: 1 },
  kuruoshi:{ icon: "🍶", label: "🍶 狂おし", pts: 1 },
  wabishi:{ icon: "🍃", label: "🍃 わびし", pts: 1 },
  yugen:  { icon: "🌙", label: "🌙 幽玄", pts: 1 },
  tae:    { icon: "🪭", label: "🪭 妙なり (一発優勝！)", pts: 10 }
};

export const hostOptionKeys = ['okashi', 'aware', 'wabisabi', 'ayashi', 'kuruoshi', 'wabishi', 'yugen', 'tae'];
export const childOptionKeys = ['okashi', 'aware', 'wabisabi'];

export function renderResults(currentData) {
  const resArea = document.getElementById('result-area');
  const roundRes = document.getElementById('round-results');
  if (!resArea || !roundRes || !currentData) return;

  const votes = currentData.votes || {};
  const phrases = currentData.phrases || {};
  
  if (Object.keys(phrases).length === 0) {
    resArea.style.display = 'none';
    return;
  }

  resArea.style.display = 'block';

  const playerPts = {};
  const hasTae = {};

  Object.keys(phrases).forEach(p => {
    playerPts[p] = 0;
    hasTae[p] = false;
  });

  Object.keys(votes).forEach(voter => {
    const voterVotes = votes[voter] || {};
    Object.keys(voterVotes).forEach(target => {
      const k = voterVotes[target];
      if (k === 'tae') {
        hasTae[target] = true;
      }
      const opt = evalOptionsMaster[k];
      if (opt && playerPts[target] !== undefined) {
        playerPts[target] += opt.pts;
      }
    });
  });

  roundRes.innerHTML = Object.keys(phrases).map(p => {
    if (hasTae[p]) {
      return `
        <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:15px; color:#b91c1c; font-weight:bold;">
          <span>・ ${p} の句</span>
          <span>🪭 妙なり獲得！この節の優勝！</span>
        </div>
      `;
    }
    return `
      <div style="display:flex; justify-content:space-between; margin-bottom:4px; font-size:14px;">
        <span>・ ${p} の句</span>
        <strong>獲得誉: +${playerPts[p]}</strong>
      </div>
    `;
  }).join('');
}
