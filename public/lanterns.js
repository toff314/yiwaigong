/* 漂浮心灯：按数量生成灯，供首页与播放页复用 */
(function () {
  function render(container, count, options) {
    if (!container) return 0;
    const opt = options || {};
    const max = opt.max || 32;   // 心灯上限
    const minOpacity = opt.minOpacity != null ? opt.minOpacity : 0.26;
    const maxOpacity = opt.maxOpacity != null ? opt.maxOpacity : 0.7;
    const n = Math.max(0, Number(count) || 0);
    const shown = n === 0 ? 0 : Math.min(n, max);
    // 数量越大灯越小，避免太挤（12 盏以下不缩，最多缩到 0.4）
    const densityScale = n <= 12 ? 1 : Math.max(0.4, 1 - (n - 12) * 0.008);

    container.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < shown; i++) {
      const lantern = document.createElement('span');
      lantern.className = 'lantern';
      const size = ((0.75 + Math.random() * 1.05) * densityScale).toFixed(2);
      const dur = 15 + Math.random() * 17;
      const delay = -Math.random() * dur;
      const opacity = (minOpacity + Math.random() * (maxOpacity - minOpacity)).toFixed(2);
      const sway = (8 + Math.random() * 20).toFixed(0);

      lantern.style.setProperty('--x', (Math.random() * 94 + 3).toFixed(1) + '%');
      lantern.style.setProperty('--s', size);
      lantern.style.setProperty('--d', dur.toFixed(1) + 's');
      lantern.style.setProperty('--sd', (dur / 3).toFixed(1) + 's');
      lantern.style.setProperty('--delay', delay.toFixed(1) + 's');
      lantern.style.setProperty('--o', opacity);
      lantern.style.setProperty('--sway', sway + 'px');

      const body = document.createElement('span');
      body.className = 'lamp-body';
      body.appendChild(document.createElement('i'));
      lantern.appendChild(body);
      frag.appendChild(lantern);
    }
    container.appendChild(frag);
    return shown;
  }

  window.Lanterns = { render };
})();
