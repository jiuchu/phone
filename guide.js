/* 看懂配置页：数据全部来自 phones.js（也就是 phones.json），这页只渲染、不存任何东西。
   价格口径和主页必须一致，所以这里自己算一遍国补到手价，_phone_check.mjs 会把两边逐台对一遍。 */
(function () {
  const D = window.__PHONES || {};
  const CFG = D.phones ? D : (D.meta ? D : {});
  const MODEL = CFG.meta || {};
  const PHONES = CFG.phones || [];
  const gb = MODEL.guobu_rule || {};

  const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
  const money = n => '¥' + n.toLocaleString('zh-CN');
  function pay(p) {
    const ch = num(p.price_channel);
    if (!Number.isFinite(p.price_ref)) return ch;
    let off = p.price_ref;
    if ((gb.applies_to_kinds || []).includes(p.price_kind))
      off = Math.round(p.price_ref - Math.min(p.price_ref * (gb.rate || 0), Number.isFinite(gb.cap_yuan) ? gb.cap_yuan : Infinity));
    return ch == null ? off : Math.min(off, ch);
  }
  const COLOR = b => b <= 4 ? 'var(--gold)' : b <= 7 ? 'var(--sky)' : 'var(--dimmer)';

  const bands = MODEL.soc_bands || [];
  const ladder = document.getElementById('ladder');
  ladder.innerHTML = bands.map(b => {
    const ms = PHONES.filter(p => p.soc_band === b.band).sort((x, y) => (pay(x) ?? 9e9) - (pay(y) ?? 9e9));
    if (!ms.length) return '';
    const w = Math.round((bands.length + 1 - b.band) / bands.length * 100);
    return `<div class="rung">
      <div class="no">${b.band}</div>
      <div class="who">${b.line}<small>${b.note || ''}</small></div>
      <div class="bar"><i style="width:${w}%;background:${COLOR(b.band)}"></i>${
        ms.map(p => `<span class="m">${p.model} <b>${pay(p) == null ? '待核' : money(pay(p))}</b></span>`).join('')
      }</div>
    </div>`;
  }).join('');

  document.getElementById('basis').textContent = MODEL.soc_band_basis || '';
  document.getElementById('gnote').textContent = MODEL.glossary_note || '';

  const G = MODEL.glossary || [];
  const groups = [];
  G.forEach(e => { const last = groups[groups.length - 1]; if (last && last.g === e.g) last.items.push(e); else groups.push({ g: e.g, items: [e] }); });
  document.getElementById('gloss').innerHTML = groups.map(gr => `<div class="grp">${gr.g}</div>
    <div class="gcards">${gr.items.map(e => `<div class="gc">
      <h3>${e.term}</h3>
      <p>${e.plain}</p>
      <p class="why"><b>为什么要在意</b> ${e.why}</p>
      ${e.look ? `<p class="look">${e.look}</p>` : ''}
    </div>`).join('')}</div>`).join('');

  const n = PHONES.length;
  const priced = PHONES.filter(p => pay(p) != null).length;
  document.getElementById('stamp').textContent =
    `天梯里 ${bands.length} 档、${n} 台机器（${priced} 台有到手价）。数据核对日 ${MODEL.data_checked_at || '未标'} —— 价格会动，这页不自动更新，改的是 phones.json。`;

  window.__GUIDE = { pay, COLOR };
})();
