/* 选手机系统 —— 页面只渲染，机型数据全在 phones.json。
   改机型/改档位/改奖励，都只动 phones.json，不动这个文件。
test
   数据怎么进页面（两条路，顺序如下）：
   1) phones.js —— 由 Temp/ephcheck/_phone_build.mjs 从 phones.json 生成的 `window.__PHONES = {...}`。
      有了它，双击 index.html（file://）也能看，因为浏览器在 file:// 下不允许 fetch 同目录的 json。
   2) fetch('phones.json') —— 走本地服务器时直接读原文件。
   页面里不留内联副本：数据抄两份必然对不上，宁可缺数据时白屏提示，也不拿旧档位糊人。 */

const LS = { pref: 'jjc_phone_pref_v1', sel: 'jjc_phone_sel_v1', score: 'jjc_phone_score_v1' };
let CFG = null;              /* 整个数据对象 { meta, phones } */
let MODEL = null;            /* CFG.meta */
let DATA_FROM = '';          /* 这页数据是从哪一路来的，页脚要说 */

/* ---------- 小工具 ---------- */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
const isNil = v => v == null || v === '' || v === '未标明' || v === null;
const money = v => (num(v) == null ? '—' : '¥' + Number(v).toLocaleString('zh-CN'));
function readJSONFile(name) {
  return fetch(name + '?v=' + Date.now(), { cache: 'no-store' })
    .then(r => (r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status))))
    .then(t => JSON.parse(t));
}

/* ---------- 档位 ---------- */
/* 排序用的档位表：按 min_score 排好，方便找「上一档」做本档的下界 */
function tierList() {
  return [...(MODEL.budget_tiers || [])].sort((a, b) => a.min_score - b.min_score);
}
function tierOf(score) {
  const tiers = tierList();
  const hit = tiers.find(t => score >= t.min_score && score <= (t.max_score ?? 999));
  if (hit) return hit;
  const min = tiers.length ? tiers[0].min_score : Infinity;
  return isFinite(min) && score < min ? { below: true, min_score: min } : null;
}
/* 上一档的预算 = 本档的下界。低于最低档时没有上一档，下界用 0（全都算本档）。 */
function prevBudget(t) {
  const tiers = tierList();
  const i = tiers.findIndex(x => x.min_score === t.min_score);
  return i > 0 ? tiers[i - 1].budget : 0;
}
/* 她勾了「愿意为拍照多花 1000」，本档上限抬高 1000 —— 相机是这一档和上一档唯一的实差别 */
function ceilingOf(t) {
  const extra = pref.camPay ? (MODEL.camera_stretch || 1000) : 0;
  return t.budget + extra;
}
/* 落档看「到手价」，不看指导价：他的预算是掏出去的钱。
   国补按 2025 年那轮的口径估（补 15%、单台上限 500 元），比率和上限都写在数据里，页面自己算，
   不在 phones.json 里给每台机器抄一个数 —— 抄了就和规则对不上。
   只有官方口径（指导价/官网现价）才叠这个折扣；电商参考价本身已经是活动价，再乘一次就是把便宜算了两遍。 */
function officialPay(p) {
  const ref = num(p.price_ref);
  if (ref == null) return null;
  const g = MODEL.guobu_rule || {};
  const kinds = g.applies_to_kinds || [];
  if (!kinds.includes(p.price_kind)) return ref;
  const off = Math.min(ref * (num(g.rate) || 0), num(g.cap_yuan) == null ? Infinity : num(g.cap_yuan));
  return Math.round(ref - off);
}
/* 渠道实付价（百亿补贴这类）本身已经是掏出去的钱，不再叠国补。
   两个口径都留在数据里：官网现价算「官方涨了多少」，渠道价算「她实际掏多少」，落档取低的。 */
function payPrice(p) {
  const official = officialPay(p);
  const ch = num(p.price_channel);
  if (ch == null) return official;
  if (official == null) return ch;
  return Math.min(official, ch);
}

/* ---------- 硬性条件 ---------- */
function rejects(p, h) {
  const out = [];
  if (!h) return out;
  const ram = num(p.ram_gb), rom = num(p.rom_gb), bat = num(p.battery_mah), w = num(p.weight_g);
  if (h.ram_gb_min != null && ram != null && ram < h.ram_gb_min) out.push(`内存 ${ram}G（要求 ≥${h.ram_gb_min}G）`);
  if (h.rom_gb_min != null && rom != null && rom < h.rom_gb_min) out.push(`存储 ${rom}G（要求 ≥${h.rom_gb_min}G）`);
  if (h.battery_mah_min != null && bat != null && bat < h.battery_mah_min) out.push(`电池 ${bat}mAh（要求 ≥${h.battery_mah_min}）`);
  if (h.pwm_high_freq && p.pwm_high_freq === false) out.push('低频 PWM 调光');
  return out;
}
function flags(p, h) {          /* 不淘汰，但要标出来让她自己看 */
  const f = [];
  const w = num(p.weight_g);
  if (h && h.weight_flag_above_g != null && w != null && w > h.weight_flag_above_g) f.push(`${w}g，偏重`);
  if (p.telephoto === false) f.push('没有长焦');
  if (p.pwm_high_freq == null) f.push('调光频率没查到官方数');
  /* 具体是哪几栏空着，直接点名 —— 光说「没读到」没人知道说的是哪一个 */
  const missing = [['重量', 'weight_g'], ['系统版本', 'os'], ['最大存储', 'rom_max_gb'], ['有没有长焦', 'telephoto']]
    .filter(([_, k]) => p[k] == null).map(([n]) => n);
  if (missing.length) f.push(`${missing.join('、')}官网没给到`);
  if (p.verified === false) f.push('参数出处见下方，官网未逐条核对');
  if (num(p.price_ref) == null) f.push('512 版价格待核');
  return f;
}

/* ---------- 她那一栏怎么影响排序 ---------- */
function testFor(key, p) {
  const h = MODEL.hard_filters || {};
  switch (key) {
    case 'battery': { const b = num(p.battery_mah); return b == null ? null : b >= h.battery_mah_min + 300; }
    case 'perf': { const t = String(p.soc_tier || ''); return /旗舰/.test(t) ? true : t ? false : null; }
    case 'screen': return p.pwm_high_freq == null ? null : !!p.pwm_high_freq;
    case 'camera': { const c = String(p.cam_rating || ''); return /很强|好/.test(c) ? true : c ? false : null; }
    case 'light': { const w = num(p.weight_g); return w == null ? null : w <= h.weight_flag_above_g - 10; }
    case 'charge': { const c = num(p.charge_w); return c == null ? null : c >= h.charge_fast_w_min; }
    case 'storage': { const r = num(p.rom_max_gb); return r == null ? null : r >= h.rom_1tb_gb; }  /* 能不能买到 1TB，不是她这一档买不买得起 */
    case 'looks': case 'price': return undefined;      /* 外观要她自己看图；价格页面只用来排序，不当偏好打分 */
    default: return undefined;
  }
}
function matchInfo(p, prefs) {
  let yes = 0, ans = 0, unans = 0;
  for (const k of prefs) {
    const v = testFor(k, p);
    if (v === undefined) { unans++; continue; }
    if (v === null) { ans++; continue; }
    ans++; if (v) yes++;
  }
  return { yes, ans, unans };
}

/* ---------- 渲染 ---------- */
function renderMeta() {
  const sc = MODEL.scoring || {};
  $('baseline').textContent = `参考点：${sc.baseline_where || ''} ${sc.baseline_max ?? ''} 分 · 年级第 ${sc.baseline_grank ?? ''} 名 · ${sc.scale || ''}`;
  const ps = (CFG.phones || []);
  const ok = ps.filter(p => p.verified !== false).length;
  const rf = MODEL.price_refresh;
  $('meta').textContent = `机型 ${ps.length} 条 · 已逐条核对官网 ${ok} 条 · 数据核对于 ${MODEL.data_checked_at || '未填'} · 数据来源：${DATA_FROM}`
    + (rf ? ` · 官网商城现价最后一次重读 ${rf.at}，能重读的是 ${rf.count} 台（${rf.brands}），另外 ${ps.length - rf.count} 台是发布指导价或电商参考价口径，读不到今天的价` : '');
  $('phint').innerHTML = (MODEL.caveats || []).map(c => '· ' + esc(c)).join('<br>');
}
function renderScoreQuick() {
  const tiers = tierList();
  $('quick').innerHTML = tiers.map(t =>
    `<button class="chipbtn" data-sc="${t.min_score}">${t.min_score} 分 → ${money(t.budget)}</button>`).join('');
  $('quick').querySelectorAll('.chipbtn').forEach(b =>
    b.onclick = () => { $('score').value = b.dataset.sc; save(LS.score, b.dataset.sc); render(); });
}
function renderHard() {
  const h = MODEL.hard_filters || {};
  const items = [
    `存储 ≥ ${h.rom_gb_min}GB`,
    `运行内存 ≥ ${h.ram_gb_min}GB（8GB 一律不选）`,
    `电池 ≥ ${h.battery_mah_min}mAh`,
    `屏幕 ≥ ${h.screen_min || '1.5K 120Hz'}，且高频 PWM 调光`,
    `重量超过 ${h.weight_flag_above_g}g 的不淘汰，但会在卡片上标出来`
  ];
  (h.reasons || []).forEach(r => items.push(r));
  $('hardList').innerHTML = items.map(i => `<li>${esc(i)}</li>`).join('');
  /* 被刷掉的机型要说清理由，不然她问「为什么没有那台」时没得指 */
  const h2 = MODEL.hard_filters || {};
  const out = (CFG.phones || []).map(p => ({ p, why: rejects(p, h2) })).filter(x => x.why.length);
  $('unranked').innerHTML = out.length
    ? `已按硬性条件刷掉 ${out.length} 条：` + out.map(x => `${esc(x.p.model)}（${x.why.map(esc).join('；')}）`).join('、')
    : '';
}
function linkBlock(p) {
  const shops = MODEL.shops || [];
  const q = p.search_key || (p.brand + ' ' + p.model);
  let html = shops.map((s, i) =>
    `<a class="${i === 0 ? 'pri' : ''}" target="_blank" rel="noopener" href="${esc(s.url.replace('{q}', encodeURIComponent(q)))}">${esc(s.name)}</a>`);
  if (p.official_spec_url) html.push(`<a target="_blank" rel="noopener" href="${esc(p.official_spec_url)}">官网参数页</a>`);
  return `<div class="buy">${html.join('')}</div>`;
}
function cardHTML(p, prefs) {
  const h = MODEL.hard_filters || {};
  const m = matchInfo(p, prefs);
  const sp = [];
  const push = (t, cls) => sp.push(`<span class="sp ${cls || ''}">${esc(t)}</span>`);
  if (!isNil(p.soc)) push(p.soc); else push('芯片未标明', 'warn');
  push(`${p.ram_gb || '?'}+${p.rom_gb || '?'}GB`, (num(p.ram_gb) >= h.ram_gb_min && num(p.rom_gb) >= h.rom_gb_min) ? 'good' : 'bad');
  if (p.rom_max_gb >= (h.rom_1tb_gb || Infinity)) push('这型号最大能买到 1TB', 'good');
  if (!isNil(p.battery_mah)) push(`${p.battery_mah}mAh`, num(p.battery_mah) >= h.battery_mah_min ? 'good' : 'warn');
  if (!isNil(p.charge_w)) push(`${p.charge_w}W 快充`);
  if (p.wireless_charge) push('无线充');
  if (!isNil(p.screen)) push(p.screen);
  if (p.pwm_high_freq === true) push('高频调光', 'good'); else if (p.pwm_high_freq === false) push('低频调光', 'bad');
  if (!isNil(p.weight_g)) push(`${p.weight_g}g`);
  if (!isNil(p.main_cam)) push(p.main_cam);
  if (p.telephoto === true) push('有长焦', 'good');
  if (!isNil(p.os)) push(p.os);
  const pay = payPrice(p), g = MODEL.guobu_rule || {};
  const ch = num(p.price_channel), off = officialPay(p);
  const useCh = ch != null && (off == null || ch <= off);
  if (useCh) push('渠道实付价', 'good');
  else if (pay != null && num(p.price_ref) != null && pay < p.price_ref) push(`到手含国补估算（${Math.round((g.rate || 0) * 100)}%、上限 ${money(g.cap_yuan)}）`, 'good');
  const fl = flags(p, MODEL.hard_filters).map(t => `<span class="sp warn">${esc(t)}</span>`).join('');
  const tally = m.ans ? `<span class="tally">你勾的里面它中了 <b>${m.yes}</b> / ${m.ans} 项${m.unans ? `（${m.unans} 项页面判断不了）` : ''}</span>`
    : `<span class="tally">${m.unans ? `${m.unans} 项要你自己看` : ''}</span>`;
  const dupBrand = String(p.model || '').startsWith(String(p.brand || ''));
  const pic = (Array.isArray(p.img) ? p.img : []).slice(0, 2)
    .map(u => `<img src="${esc(u)}" alt="${esc(p.model)} 官方渲染图" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`).join('');
  return `<div class="pcard${sel.has(p.id) ? ' sel' : ''}" data-id="${esc(p.id)}">
    <div class="ptop">
      <div>${dupBrand ? '' : `<div class="pbrand">${esc(p.brand)}</div>`}<div class="pname">${esc(p.model)}</div></div>
      <div class="price"><span class="amt">${pay == null ? '—' : money(pay)}</span><small>${p.price_ref == null && ch == null ? '价格待核'
        : useCh ? `渠道实付 · 官网 ${money(p.price_ref)}<br>${esc(p.price_channel_kind || '渠道价')} ${esc(p.price_channel_date || '')}<br>官网到手估 ${off == null ? '—' : money(off)}`
        : pay < p.price_ref
          ? `到手估 · 指导 ${money(p.price_ref)}<br>${esc(p.price_date)} ${esc(p.price_kind || '参考价')}`
          : `${esc(p.price_date)} ${esc(p.price_kind || '参考价')}<br>这个口径不另叠国补`}</small></div>
    </div>
    ${pic ? `<div class="pimg">${pic}</div>` : ''}
    <div class="specs">${sp.join('')}${fl}</div>
    ${p.spec_source ? `<div class="note">参数出处：${esc(p.spec_source)}</div>` : ''}
    ${p.notes ? `<div class="note">${esc(p.notes)}</div>` : ''}
    ${linkBlock(p)}
    <div class="pfoot">
      <label class="row" style="gap:6px;font-size:12.5px;color:var(--dim);cursor:pointer">
        <input type="checkbox" class="jsel" style="width:16px;height:16px;accent-color:var(--gold)" ${sel.has(p.id) ? 'checked' : ''}>想要这台
      </label>
      ${tally}
    </div>
  </div>`;
}
function byMatch(list, prefs) {
  return list.sort((a, b) => {
    const ma = matchInfo(a, prefs), mb = matchInfo(b, prefs);
    const ra = ma.ans ? ma.yes / ma.ans : -1, rb = mb.ans ? mb.yes / mb.ans : -1;
    if (rb !== ra) return rb - ra;
    if (mb.yes !== ma.yes) return mb.yes - ma.yes;
    return (payPrice(a) ?? 9e9) - (payPrice(b) ?? 9e9);
  });
}
/* 本档 = 上一档预算 < 到手价 ≤ 本档预算。这样每提一档看到的是新解锁的机器，
   而不是「考 560 分和考 490 分给的是同一张长列表」。便宜的那些收进折叠区，想买也能买。 */
function renderPhones(score) {
  const t = tierOf(score), box = $('phones');
  if (!t || t.below || !(CFG.phones || []).length) {
    box.innerHTML = `<div class="empty">${!t ? '这个分数不在档位里，先去 phones.json 的 budget_tiers 补一档。'
      : t.below ? `低于最低档 ${t.min_score} 分 —— 这一档不在激励里，页面就不给机型了。`
      : 'phones.json 里还没有机型。数据核对完成后会自动出现。'}</div>`;
    $('selTally').textContent = ''; return;
  }
  const prefs = prefOrder.filter(k => prefChk.has(k));
  const h = MODEL.hard_filters, ceil = ceilingOf(t), low = prevBudget(t);
  const band = `${t.min_score}–${t.max_score ?? 999} 分`;
  const ok = (CFG.phones || []).filter(p => rejects(p, h).length === 0);
  const priced = ok.filter(p => payPrice(p) != null);
  const unpriced = ok.filter(p => payPrice(p) == null);
  let here = priced.filter(p => payPrice(p) <= ceil && payPrice(p) > low);
  let under = priced.filter(p => payPrice(p) <= low);
  const blocked = (CFG.phones || []).filter(p => payPrice(p) != null && payPrice(p) <= ceil
    && payPrice(p) > low && rejects(p, h).length);
  if ($('onlySel').checked) {
    here = here.filter(p => sel.has(p.id)); under = under.filter(p => sel.has(p.id));
  }
  byMatch(here, prefs); byMatch(under, prefs);
  const stretch = pref.camPay && ceil > t.budget
    ? `<div class="hint">因为勾了「愿意为拍照多花 ${MODEL.camera_stretch || 1000}」，这一档上限放到 ${money(ceil)}。</div>` : '';
  /* 本档空着的时候说清是「这个价位根本没机器」还是「有机器但被硬性条件刷掉」，
     前者要去市场上找机器，后者是条件本身的问题，他俩做的事不一样。 */
  const stretchAmt = MODEL.camera_stretch || 1000;
  const justAbove = priced.filter(p => { const v = payPrice(p); return v > t.budget && v <= t.budget + stretchAmt; });
  const empty = () => {
    const lead = blocked.length
      ? `${esc(band)} / ${money(t.budget)}：这个价位里有机器，但都卡在硬性条件上。`
      : `${esc(band)} / ${money(t.budget)}：${money(low)}～${money(ceil)} 这个价钱里一台机型都没有收录 —— 不是被条件刷掉的，是这个价位本来买不到符合要求的机器。`;
    const up = (!pref.camPay && justAbove.length)
      ? `往上多花一点够得着的是 ${justAbove.map(p => `${esc(p.model)}（到手 ${money(payPrice(p))}）`).join('、')}，勾上「愿意为拍照多花 ${stretchAmt}」它就进这一档。` : '';
    return `<div class="empty">${lead}`
      + blocked.map(p => `差一点的是 ${esc(p.model)}（${esc(rejects(p, h).join('；'))}）。`).join('')
      + up
      + (under.length ? `想省钱的话，往下那 ${under.length} 台都在下面的折叠区里。` : '')
      + `要补机器就改 phones.json，页面不用动。</div>`;
  };
  box.innerHTML =
    (here.length ? `<div class="grid">${here.map(p => cardHTML(p, prefs)).join('')}</div>` : empty())
    + stretch
    + (under.length ? `<details class="under"><summary>往下还可以买（${under.length} 台，省钱的话）</summary>
        <div class="grid">${under.map(p => cardHTML(p, prefs)).join('')}</div></details>` : '')
    + (unpriced.length ? `<div class="hint">另有 ${unpriced.length} 条机型参考价还没核对，暂时不进候选；核对完自动出现。</div>` : '');
  box.querySelectorAll('.jsel').forEach(c => c.onchange = e => {
    const id = e.target.closest('.pcard').dataset.id;
    e.target.checked ? sel.add(id) : sel.delete(id);
    save(LS.sel, [...sel]); e.target.closest('.pcard').classList.toggle('sel', e.target.checked); renderSelTally();
  });
  renderSelTally();
}
function renderSelTally() {
  const n = sel.size;
  $('selTally').textContent = n ? `已选 ${n} 台` : '';
}

/* ---------- 预算条 ---------- */
function renderBudget(score) {
  const t = tierOf(score);
  if (!t || t.below) { $('budAmt').textContent = '—'; $('budBand').textContent = t ? `低于 ${t.min_score} 分` : '不在档位里'; $('budSay').textContent = ''; return; }
  $('budAmt').textContent = money(t.budget);
  $('budBand').textContent = `${t.min_score}–${t.max_score ?? ''} 分 · ${t.label || ''}`;
  const low = prevBudget(t), ceil = ceilingOf(t);
  $('budSay').innerHTML = esc(t.say || '') + (low
    ? `<br>这一档看的是到手 ${money(low + 1)} 到 ${money(ceil)} 之间的机器，再便宜的收在折叠区里。`
    : `<br>这是最低一档，到手 ${money(ceil)} 以内符合硬性条件的都在这里。`);
}

/* ---------- 进步奖励 ---------- */
function renderRewards() {
  const pr = MODEL.progress_rewards || {}, body = $('rewardTable').querySelector('tbody');
  const rows = (pr.items || []).map(it => `<tr${it.dead ? ' class="dead"' : ''}>
    <td>${esc(it.exam)}</td><td>${esc(it.how)}</td><td><b>${esc(it.gives)}</b>${it.why ? `<div class="note">${esc(it.why)}</div>` : ''}</td></tr>`);
  body.innerHTML = rows.join('') || '<tr><td colspan="3" class="note">phones.json 里还没写奖励条目</td></tr>';
  $('rewardNote').textContent = [pr.start_line || '', pr.note || '', pr.price_fluctuation || ''].filter(Boolean).join(' ');
  renderRewardRef(pr.reference);
}
/* 「现在的底」——真实成绩只当参照，不当结算依据，所以这句话必须跟数字一起画出来 */
function renderRewardRef(R) {
  const box = $('rewardRef');
  if (!box) return;
  if (!R) { box.innerHTML = ''; return; }
  const pill = (lab, o, extra) => !o ? '' :
    `<span class="sp">${esc(lab)} ${esc(String(o.total))} 分 · ${esc(String(o.when))}${esc(extra || '')}</span>`;
  const dk = R.latest_diaokao;
  box.innerHTML = `<div class="row">${pill('最高调考', R.max_diaokao)}`
    + pill('最近一场调考', dk, dk && dk.prev_total != null ? `（上一场 ${dk.prev_total} 分 · ${dk.prev_when}）` : '')
    + pill('最近一场小月考', R.latest_yuekao, R.latest_yuekao && R.latest_yuekao.note ? `（${R.latest_yuekao.note}）` : '')
    + (R.at ? `<span class="note">成绩记到 ${esc(R.at)}</span>` : '')
    + `</div>` + (R.caveat ? `<div class="hint">${esc(R.caveat)}</div>` : '');
}

/* ---------- 试算：把上面那张表的规则跑一遍 ---------- */
const pi = v => { const x = String(v == null ? '' : v).trim(); return x === '' || !isFinite(+x) ? null : Math.round(+x); };

/* 纯函数：进两场的名次/总分 + 这一场的数学单科名次 + 账上已记的两件事，出明细。
   规则本身一个都不写在这儿 —— 全部读 progress_rewards.calc，跟表里那些句子由校验脚本钉在一起。 */
function payoutOf(inp) {
  const M = MODEL || {}, pr = M.progress_rewards || {}, c = pr.calc || {}, sc = M.scoring || {};
  const cap = v => (num(v) == null ? Infinity : num(v));
  const perName = num(c.rank_per_name) || 0, stepNames = num(pr.unit_rank) || 0;
  const perScore = num(c.score_per_step) || 0, perYk = num(c.yuekao_per_step) || 0;
  const stepPts = num(pr.unit_points) || 0, base = num(sc.baseline_grank);
  const dk = inp.kind !== 'yk';
  const pR = pi(inp.prev_rank), rR = pi(inp.rank), pT = pi(inp.prev_total), rT = pi(inp.total);
  const dRank = (pR != null && rR != null) ? pR - rR : null;
  const dTot = (pT != null && rT != null) ? rT - pT : null;
  const lines = [];
  let guard = false;

  if (dk) {
    let y = 0, w = '';
    if (dRank == null) w = '上一场和这一场的年级名次都要填';
    else if (dRank <= 0) { guard = true; w = dRank === 0 ? '名次没动' : `名次退了 ${-dRank} 名`; }
    else {
      const raw = dRank * perName; y = Math.min(raw, cap(c.rank_cap));
      w = `前进 ${dRank} 名 × ¥${perName}${y < raw ? ` = ¥${raw}，这条封顶 ¥${c.rank_cap}` : ''}`;
    }
    lines.push({ rule: '年级名次线（主）', how: w, yuan: y });
    let s = 0, w2 = '';
    if (guard) w2 = '上一行名次没前进 ⇒ 这一条整条不结';
    else if (dRank == null) w2 = '要先看名次：上面两场的年级名次填了才算这条';
    else if (dTot == null) w2 = '上一场和这一场的总分都要填';
    else {
      const st = Math.floor(Math.max(0, dTot) / stepPts), raw = st * perScore;
      s = Math.min(raw, cap(c.score_cap));
      w2 = dTot <= 0 ? '卷面分没涨'
        : `涨 ${dTot} 分 ÷ ${stepPts} = ${st} 档 × ¥${perScore}${s < raw ? ` = ¥${raw}，这条封顶 ¥${c.score_cap}` : ''}`;
    }
    lines.push({ rule: '卷面分线（副）', how: w2, yuan: s });
  } else {
    let s = 0, w = '';
    if (dTot == null) w = '上一场小月考的总分没填（第一场没有上一场，这条本来就不结）';
    else {
      const st = Math.floor(Math.max(0, dTot) / stepPts), raw = st * perYk;
      s = Math.min(raw, cap(c.yuekao_cap));
      w = dTot <= 0 ? '比上一场小月考没涨分'
        : `涨 ${dTot} 分 ÷ ${stepPts} = ${st} 档 × ¥${perYk}${s < raw ? ` = ¥${raw}，一个月封顶 ¥${c.yuekao_cap}` : ''}`;
    }
    lines.push({ rule: '学校小月考', how: w, yuan: s });
  }

  /* 台阶：一场只结「这一场够到的最高那一级」，而且只在新够到时才结 ——
     所以问的是账上记到的最好一级，不是问结过哪几级：只问结过的话，
     停在同一水平也能一格一格往下补钱，那就成了重复给。 */
  const lad = c.ladder || [], mr = pi(inp.math_rank), best = pi(inp.math_best);
  let ly = 0, lw = '';
  if (!lad.length) lw = 'phones.json 里还没写 calc.ladder';
  else if (mr == null) lw = '没填这一场的数学单科年级名次';
  else {
    const reach = lad.filter(x => mr <= x.rank_max).sort((a, b) => a.rank_max - b.rank_max);
    if (!reach.length) lw = `这一场 ${mr} 名，还没够到最低那一级（前 ${Math.max(...lad.map(x => x.rank_max))} 名）`;
    else if (best === 0) lw = '六级都已经在账上了 ⇒ 这一条以后不再结';
    else if (best != null && reach[0].rank_max >= best) lw = `这一场够到的最高一级是前 ${reach[0].rank_max} 名，账上已经记到前 ${best} 名 ⇒ 只结新够到的那一级`;
    else {
      ly = reach[0].yuan;
      lw = `这一场 ${mr} 名，新够到前 ${reach[0].rank_max} 名这一级 ⇒ 一场只结最高那一级${best == null ? '' : `，账上原来记的是前 ${best} 名`}`;
    }
  }
  lines.push({ rule: '数学单科名次台阶', how: lw, yuan: ly });

  let ry = 0, rw = '';
  if (!dk) rw = '小月考不算这一条（只跟调考的历史最高名次比）';
  else if (rR == null) rw = '没填这一场的年级名次';
  else if (base == null) rw = 'phones.json 里没写历史最高名次';
  else if (rR > base) rw = `这一场 ${rR} 名，还没好过历史最高的第 ${base} 名`;
  else if (rR === base) rw = `正好 ${base} 名 —— 平纪录不结`;
  else if (inp.record_paid) rw = '以前已经结过一次 ⇒ 这一条只结一次';
  else { ry = num(c.record_bonus) || 0; rw = `这一场 ${rR} 名，好过历史最高的第 ${base} 名`; }
  lines.push({ rule: '调考刷新历史最高', how: rw, yuan: ry });

  const pair = lines.slice(0, dk ? 2 : 1).reduce((a, x) => a + x.yuan, 0);
  const pairCap = dk ? cap(c.session_cap) : cap(c.yuekao_cap);
  return {
    kind: dk ? 'dk' : 'yk', lines, pair, pairCap,
    pair_hit: pair >= pairCap && pair > 0,
    total: pair + ly + ry, guard
  };
}

let calcKind = 'dk';
function calcInput() {
  return {
    kind: calcKind,
    prev_rank: $('calcPrevRank').value, rank: $('calcRank').value,
    prev_total: $('calcPrevTotal').value, total: $('calcTotal').value,
    math_rank: $('calcMath').value, math_best: $('calcBest').value,
    record_paid: $('calcRecPaid').checked
  };
}
function renderCalc() {
  const pr = MODEL.progress_rewards || {}, c = pr.calc || {}, box = $('calcCard');
  if (!box) return;
  if (!(c.ladder || []).length) { box.innerHTML = '<div class="note">phones.json 里还没写 calc 这块数字，试算先不能用。</div>'; return; }
  const low = Math.max(...c.ladder.map(x => x.rank_max));
  $('calcBest').innerHTML = `<option value="">这套规则上线以来还没进过前 ${low} 名</option>`
    + c.ladder.slice().sort((a, b) => b.rank_max - a.rank_max)
      .map(x => `<option value="${x.rank_max}">已经进过前 ${x.rank_max} 名（那一级 ¥${x.yuan} 给过了）</option>`).join('')
    + `<option value="0">比前 ${Math.min(...c.ladder.map(x => x.rank_max))} 名还好，六级都算给过了</option>`;
  ['calcDk', 'calcYk', 'calcPrevRank', 'calcRank', 'calcPrevTotal', 'calcTotal', 'calcMath', 'calcBest', 'calcRecPaid']
    .forEach(id => { const el = $(id); if (el) el.onchange = drawCalc; if (el) el.oninput = drawCalc; });
  $('calcDk').onclick = () => { calcKind = 'dk'; drawCalc(); };
  $('calcYk').onclick = () => { calcKind = 'yk'; drawCalc(); };
  drawCalc();
}
function drawCalc() {
  const r = payoutOf(calcInput()), dk = r.kind === 'dk';
  $('calcDk').classList.toggle('on', dk);
  $('calcYk').classList.toggle('on', !dk);
  $('calcPrevLabel').textContent = dk ? '上一场调考' : '上一场小月考';
  const rows = r.lines.map(x => `<tr><td>${esc(x.rule)}</td><td>${esc(x.how)}</td><td><b>${x.yuan ? money(x.yuan) : '—'}</b></td></tr>`);
  const sub = `${dk ? '两条线小计' : '小计'} ${money(r.pair)} · ${dk ? '这两条的上限' : '这一条的上限'} ¥${r.pairCap}${r.pair_hit ? '（已经到顶）' : ''}`;
  $('calcOut').querySelector('tbody').innerHTML = rows.join('')
    + `<tr><td>这一场合计</td><td>${sub}${r.guard ? ' · 名次没前进，副的那条按护栏也不结' : ''}</td><td><b>${money(r.total)}</b></td></tr>`;
  $('calcHint').textContent = r.guard
    ? '这一场年级名次没前进：按表里那条护栏，名次线和分数线都不结，也不倒扣。'
    : '这里只是试算，不替你记账 —— 台阶记到前几级、破纪录给没给过，得你自己核。数学涨上去那一晚名次线、分数线、台阶三条同时响，这是故意的。';
}

/* ---------- 她那一栏 ---------- */
let prefChk = new Set(), prefOrder = [], sel = new Set();
function renderPrefs() {
  const ps = MODEL.priorities || [];
  if (!prefOrder.length) prefOrder = ps.map(p => p.key);
  $('prefChips').innerHTML = ps.map(p => `<label class="it">
      <input type="checkbox" data-k="${esc(p.key)}" ${prefChk.has(p.key) ? 'checked' : ''}>${esc(p.label)}
    </label>`).join('') || '<span class="note">phones.json 的 priorities 是空的</span>';
  $('prefChips').querySelectorAll('input').forEach(c => c.onchange = e => {
    e.target.checked ? prefChk.add(e.target.dataset.k) : prefChk.delete(e.target.dataset.k);
    savePref(); render();
  });
  const label = k => (ps.find(p => p.key === k) || {}).label || k;
  const manual = k => { const v = testFor(k, {}); return v === undefined ? '<span class="note">（这项页面判断不了，靠你自己看）</span>' : ''; };
  $('prefOrder').innerHTML = prefOrder.map((k, i) => `<li>
      <span class="n">${i + 1}</span><span class="grow">${esc(label(k))} ${manual(k)}</span>
      <button class="ordrbtn" data-i="${i}" data-d="-1" ${i ? '' : 'style="visibility:hidden"'}>↑</button>
      <button class="ordrbtn" data-i="${i}" data-d="1" ${i === prefOrder.length - 1 ? 'style="visibility:hidden"' : ''}>↓</button>
    </li>`).join('');
  $('prefOrder').querySelectorAll('.ordrbtn').forEach(b => b.onclick = () => {
    const i = +b.dataset.i, d = +b.dataset.d, j = i + d;
    if (j < 0 || j >= prefOrder.length) return;
    [prefOrder[i], prefOrder[j]] = [prefOrder[j], prefOrder[i]];
    savePref(); renderPrefs(); render();
  });
  $('camPay').checked = !!pref.camPay;
  $('ownNote').value = pref.ownNote || '';
  $('prefStamp').textContent = pref.savedAt ? `上次保存 ${pref.savedAt}` : '还没保存过';
}
let pref = {};
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } };
function savePref() {
  pref = { ...pref, chk: [...prefChk], order: prefOrder, camPay: $('camPay').checked, ownNote: $('ownNote').value,
    savedAt: new Date().toLocaleString('zh-CN', { hour12: false }) };
  save(LS.pref, pref); save(LS.sel, [...sel]);
}

/* ---------- 主渲染 ---------- */
function render() {
  const s = num(+$('score').value);
  if (s != null) save(LS.score, s);
  renderBudget(s ?? 0); renderPhones(s ?? 0);
}

/* ---------- 取数：phones.js（file:// 双击也能用）→ phones.json（走服务器） ---------- */
async function loadData() {
  if (window.__PHONES && window.__PHONES.meta) { DATA_FROM = 'phones.js（由 phones.json 生成）'; return window.__PHONES; }
  try {
    const j = await readJSONFile('phones.json');
    if (!j || !j.meta) throw new Error('结构不对');
    DATA_FROM = 'phones.json'; return j;
  } catch (e) { return null; }
}

/* ---------- 实时价：读到了就用今天的商城标价，读不到就用库里那份快照 ----------
   三条刻意的形状，别顺手改：
   1) 一次只问一台、并发 4、每台之间隔 220ms。把 26 台并成一条请求会让单次调用的
      CPU 超掉免费档那 10 毫秒，而且一家接口抖动会把整批一起带走。
   2) 不阻塞首屏：boot 里不 await 它。它回来只是把 price_ref 换掉再 render 一次，
      档位跟着 payPrice 自己重算 —— 所以这一层整个挂掉，页面还是昨天那份能用。
   3) 只改 price_ref / price_date，绝不动 price_kind。price_kind 是国补估算的开关，
      改了等于把「到手价」口径换了一套，档位会无端端跳。 */
const LIVE_KEY = 'phonelist.live.v1';
const cfgOf = p => p.ram_gb + 'GB+' + p.rom_gb + 'GB';
const liveTargets = () => (CFG.phones || []).filter(p => p.live_price && p.live_price.via && p.live_price.id);
function hhmm(ts) {
  const d = new Date(ts), z = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes());
}
async function liveOne(ep, lp, model, cfg, ms) {
  const u = ep + '?via=' + encodeURIComponent(lp.via) + '&id=' + encodeURIComponent(lp.id)
    + '&cfg=' + encodeURIComponent(cfg) + '&m=' + encodeURIComponent(model);
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), ms) : null;
  try {
    const r = await fetch(u, ctl ? { signal: ctl.signal } : undefined);
    const j = await r.json();
    return (j && j.ok && Number.isFinite(Number(j.price)))
      ? { price: Number(j.price), at: Number(j.at) || Date.now() }
      : { err: (j && j.err) || '没回一个价' };
  } catch (e) { return { err: String((e && e.message) || e || '读不到') }; }
  finally { if (timer) clearTimeout(timer); }
}
/* map 的键是库里的 p.id，值是 {price, at}。差太多那一条是防解析取到隔壁配置/隔壁机型 ——
   宁可这台沿用快照，也不要在页面上凭空多出一个谁都没见过的价。 */
function applyLive(map, at, asked) {
  const el = $('liveStamp'), rf = MODEL.price_refresh || {};
  let used = 0, odd = 0;
  map = map || {};
  for (const p of liveTargets()) {
    const r = map[p.id];
    if (!r || !Number.isFinite(Number(r.price))) continue;
    const old = num(p.price_ref);
    if (old != null && (r.price < old * 0.5 || r.price > old * 2)) { odd++; continue; }
    p.price_ref = Number(r.price);
    p.price_date = hhmm(r.at || at);
    used++;
  }
  if (el) {
    const miss = Math.max(0, (asked || 0) - used - odd);
    el.textContent = used
      ? `今天的官网商城标价 · ${hhmm(at)} 读到 ${used} 台`
        + (miss ? `，${miss} 台沿用库里快照` : '')
        + (odd ? `；另 ${odd} 台读出来的数和快照差得超过一倍，没采用` : '')
      : `今天的商城价没读到 · 用的是库里 ${rf.at || '未记时刻'} 那份`;
  }
  render();
  return { used, odd };
}
async function runLive(force) {
  const C = MODEL.live_price || {};
  const ep = String(C.endpoint || '');
  if (!/^https:\/\//.test(ep)) return { skipped: '库里没写端点或不是 https' };
  const targets = liveTargets();
  if (!targets.length) return { skipped: '没有一台标了 live_price' };
  let cache = null;
  try { cache = JSON.parse(localStorage.getItem(LIVE_KEY) || 'null'); } catch (e) { }
  const ttl = (num(C.ttl_minutes) || 30) * 60000;
  if (!force && cache && cache.at && Date.now() - cache.at < ttl) {
    return Object.assign({ fromCache: true }, applyLive(cache.map, cache.at, targets.length));
  }
  const ms = (num(C.timeout_seconds) || 8) * 1000;
  const map = {}, q = targets.slice();
  const worker = async () => {
    while (q.length) {
      const p = q.shift();
      const r = await liveOne(ep, p.live_price, p.model, cfgOf(p), ms);
      if (!r.err) map[p.id] = r;
      await new Promise(s => setTimeout(s, 220));   /* 同一家的接口别一口气连砸 */
    }
  };
  await Promise.all([0, 1, 2, 3].map(worker));
  /* 一台也没读到就别写这份缓存：撞空那一次不该把「沿用快照」钉住半小时，
     下次打开本该重试；读到过才值得缓存 30 分钟。 */
  if (Object.keys(map).length) {
    try { localStorage.setItem(LIVE_KEY, JSON.stringify({ at: Date.now(), map })); } catch (e) { }
  }
  return Object.assign({ fromCache: false }, applyLive(map, Date.now(), targets.length));
}

/* ---------- 启动 ---------- */
(async function boot() {
  const data = await loadData();
  if (!data) {
    document.querySelector('.wrap').innerHTML = `<div class="card"><h2>没读到数据</h2>
      <div class="note" style="font-size:14px;line-height:2">
        这一页的机型不写在页面里，读的是同目录下的数据文件。现在两个来源都没拿到：<br>
        · <code>phones.js</code>（双击打开时用这个，由生成脚本从 phones.json 产出）<br>
        · <code>phones.json</code>（走本地服务器时用这个）<br>
        把 <code>index.html</code>、<code>app.js</code>、<code>phones.js</code> 三个文件放进同一个目录再双击。
      </div></div>`;
    return;
  }
  CFG = data; MODEL = CFG.meta || {};
  try {
    pref = JSON.parse(localStorage.getItem(LS.pref) || '{}') || {};
    prefChk = new Set(pref.chk || []); prefOrder = pref.order || [];
    sel = new Set(JSON.parse(localStorage.getItem(LS.sel) || '[]'));
    const s = JSON.parse(localStorage.getItem(LS.score) || 'null');
    if (num(s) != null) $('score').value = s;
  } catch (e) { }
  renderMeta(); renderScoreQuick(); renderHard(); renderPrefs(); renderRewards(); renderCalc(); render();
  $('score').oninput = render;
  $('onlySel').onchange = render;
  $('clearSel').onclick = () => { sel.clear(); save(LS.sel, []); render(); };
  $('savePref').onclick = () => { savePref(); $('prefStamp').textContent = `已保存 · ${pref.savedAt}`; render(); };
  $('resetPref').onclick = () => {
    prefChk.clear(); prefOrder = (MODEL.priorities || []).map(p => p.key);
    pref.camPay = false; pref.ownNote = ''; sel.clear();
    savePref(); renderPrefs(); render();
  };
  /* 这个勾会抬高本档上限，勾完必须重画候选，不然「为拍照多花 1000」那台要点一下分数才出现 */
  $('camPay').onchange = () => { savePref(); render(); };
  $('ownNote').onblur = savePref;
  /* 实时价放在最后、且不 await：首屏已经画完了，它回来只是换掉几个数再重画一次 */
  runLive(false).catch(() => { });
})();

/* 给离线校验脚本和浏览器自检用；正常打开页面不会碰到它 */
if (typeof globalThis !== 'undefined') globalThis.__PHONE = {
  tierOf, prevBudget, ceilingOf, payPrice, officialPay, rejects, flags, matchInfo, testFor, byMatch,
  applyLive, runLive, liveTargets, cfgOf, payoutOf,
  inject(list, extra) {
    CFG.phones = list;
    if (extra) Object.assign(CFG.meta, extra);
    MODEL = CFG.meta; DATA_FROM = '测试注入';
    renderMeta(); renderScoreQuick(); renderHard(); renderPrefs(); renderRewards(); renderCalc(); render();
  },
  state: () => ({ from: DATA_FROM, n: (CFG.phones || []).length, sel: [...sel], chk: [...prefChk], order: prefOrder })
};
