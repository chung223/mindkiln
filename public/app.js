/* ============ 女媧工坊 前端 ============ */

const $ = (sel) => document.querySelector(sel);

const state = {
  characters: [],
  current: null,      // 當前人物詳情
  chat: null,         // 當前對話
  council: null,      // 當前議事會
  jobSource: null,    // 蒸餾 SSE
  sending: false,
};

// 議事會中每位 persona 的固定色彩(依索引循環)
const PERSONA_COLORS = ['var(--gold)', 'var(--jade)', 'var(--cinnabar-bright)', '#8fa8c8', '#c88fb0', '#b0c88f'];

const STATUS_LABEL = { new: '待煉', distilling: '煉製中', ready: '已成', error: '失敗' };

const MODE_LABELS = {
  chat: '對話', predict: '預測', rehearse: '排練', letter: '未寄出的信',
  perspective: '對方視角', reflect: '反思陪伴', training: '關係練習',
};
// 感情處理模式(顯示不同色彩 + 開場提示)
const EMOTIONAL_MODES = new Set(['rehearse', 'letter', 'perspective', 'reflect']);
const MODE_HINTS = {
  chat: (n) => `以「${n}」的身份進行角色扮演對話。`,
  predict: () => '描述一個情境,預測此人會如何反應或決策(附推理依據與信心度)。',
  rehearse: (n) => `練習說出口不易的話,由「${n}」用可能的方式真實回應——為真實對話做準備,或先把情緒走一遍。`,
  letter: (n) => `寫下想說卻沒說出口的話,收到一封「${n}」語氣的回信。幫你放下的練習。`,
  perspective: (n) => `描述你們之間發生的事,讓「${n}」說出當時對方那一邊可能的心境。幫你看見全貌。`,
  reflect: (n) => `「${n}」陪你聊,同時是一面鏡子——溫柔地照見你自己的模式。`,
  training: (n) => `跟「${n}」練習一場真實的對話,一位溝通教練在旁邊給你回饋。選一個情境開始。`,
};
// mode → 對話卡片/標頭的色彩類別
function modeChipClass(mode) {
  if (mode === 'predict') return ' predict';
  if (mode === 'training') return ' training';
  if (EMOTIONAL_MODES.has(mode)) return ' emotional';
  return '';
}
const STAR = (n) => '⭐'.repeat(Math.max(1, Math.min(5, n || 1)));
const PHASES = [
  { key: 'corpus', label: '練泥 · 載入語料' },
  { key: 'research', label: '入爐 · 維度分析' },
  { key: 'synthesis', label: '提煉 · 心智模型' },
  { key: 'quality', label: '驗證 · 品質稽核' },
  { key: 'build', label: '塑形 · 人物檔案' },
];

// ---------- 基礎工具 ----------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body instanceof FormData ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    if (res.status === 401) {
      // 密碼保護中且尚未登入:跳出登入面板
      const m = $('#modal-login');
      if (m && !m.open) m.showModal();
    }
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `請求失敗（${res.status}）`);
  }
  return res.json();
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  // 用 popover 讓 toast 進入 top layer,永遠疊在 <dialog> 之上
  if (el.showPopover) {
    if (el.matches(':popover-open')) el.hidePopover();
    el.showPopover();
  } else {
    el.hidden = false; // 舊瀏覽器降級
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (el.hidePopover && el.matches(':popover-open')) el.hidePopover();
    else el.hidden = true;
  }, 3600);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 輕量 Markdown 渲染（先轉義再標記）
function renderMd(src) {
  const lines = String(src).split('\n');
  const out = [];
  let inCode = false, codeBuf = [], listType = null, inTable = false;

  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  const closeTable = () => { if (inTable) { out.push('</table>'); inTable = false; } };
  const inline = (t) =>
    esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) { out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`); codeBuf = []; }
      inCode = !inCode;
      continue;
    }
    if (inCode) { codeBuf.push(line); continue; }

    if (/^\|.*\|\s*$/.test(line)) {
      const cells = line.slice(1, line.lastIndexOf('|')).split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 分隔列
      closeList();
      if (!inTable) { out.push('<table>'); inTable = true; }
      const tag = out[out.length - 1] === '<table>' ? 'th' : 'td';
      out.push(`<tr>${cells.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`);
      continue;
    }
    closeTable();

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
      continue;
    }
    if (/^-{3,}$/.test(line.trim())) { closeList(); out.push('<hr>'); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode && codeBuf.length) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  closeList(); closeTable();
  return out.join('\n');
}

// ---------- 視圖切換 ----------

function showView(id) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
}

// ---------- 側欄人物列表 ----------

async function refreshCharacters() {
  state.characters = await api('/api/characters');
  const nav = $('#character-list');
  nav.innerHTML = '';
  for (const c of state.characters) {
    const card = document.createElement('div');
    card.className = 'char-card' + (state.current?.id === c.id ? ' active' : '');
    card.innerHTML = `
      <div class="cc-name">${esc(c.name)}</div>
      <div class="cc-meta">
        <span><span class="status-dot ${esc(c.status)}"></span>${STATUS_LABEL[c.status] || c.status}</span>
        <span>${c.sourceCount} 份語料</span>
      </div>`;
    card.addEventListener('click', () => openCharacter(c.id).catch((err) => toast(err.message, true)));
    nav.appendChild(card);
  }
  if (!state.characters.length && !state.current) showView('view-empty');
  // 人物就緒數改變時,議事會區塊的可見性/可召集性隨之更新
  if (typeof refreshCouncils === 'function') refreshCouncils().catch(() => {});
}

// ---------- 人物詳情 ----------

async function openCharacter(id) {
  closeJobStream();
  const c = await api(`/api/characters/${encodeURIComponent(id)}`);
  state.current = c;
  state.chat = null;

  $('#char-name').textContent = c.name;
  $('#char-note').textContent = c.note || '';
  $('#char-aliases-input').value = (c.aliases || []).join(', ');
  const chip = $('#char-status');
  chip.textContent = STATUS_LABEL[c.status] || c.status;
  chip.className = `status-chip ${c.status}`;
  $('#sources-path').textContent = c.sourcesPath;

  renderFiles(c.files);
  renderChats(await api(`/api/characters/${encodeURIComponent(id)}/chats`));
  renderResearch(c.research || []);
  $('#speaker-chips').innerHTML = '';
  $('#estimate-box').hidden = true;

  $('#panel-persona').hidden = !c.hasPersona;
  if (c.hasPersona) {
    $('#persona-hint').textContent = `蒸餾完成於 ${c.distilledAt ? new Date(c.distilledAt).toLocaleString('zh-TW') : '—'}。可檢視 / 編輯人物檔案,或重新蒸餾以更新。`;
    $('#btn-distill').textContent = '重新蒸餾';
  } else {
    $('#btn-distill').textContent = '開始蒸餾';
  }

  // 增量更新:蒸餾後有新增/變動的語料檔時顯示
  const pending = c.pendingSources || [];
  $('#btn-incremental').hidden = !(c.hasPersona && pending.length);
  $('#incremental-hint').hidden = !(c.hasPersona && pending.length);
  if (pending.length) {
    $('#btn-incremental').textContent = `⟳ 增量更新(${pending.length} 個新檔案)`;
    $('#incremental-hint').textContent = `偵測到新語料:${pending.join('、')}——增量更新只吃新檔,更新時間線與人物檔案,不必整條重蒸。`;
  }

  const furnace = $('#furnace');
  furnace.hidden = true;
  $('#furnace-msg').textContent = '';
  $('#furnace-msg').className = 'furnace-msg';

  if (c.status === 'error' && c.lastError) {
    furnace.hidden = false;
    $('#furnace-phases').innerHTML = '';
    $('#dim-grid').innerHTML = '';
    const msg = $('#furnace-msg');
    msg.textContent = `上次蒸餾失敗:${c.lastError}`;
    msg.className = 'furnace-msg error';
  }

  showView('view-character');
  refreshCharacters();

  if (c.activeJobId) attachJobStream(c.activeJobId);
}

const RESEARCH_LABELS = {
  '01-writings': '著作與系統思考', '02-conversations': '對話與即興思考',
  '03-expression-dna': '表達風格DNA', '04-external-views': '他者視角與批評',
  '05-decisions': '決策記錄與行動', '06-timeline': '人物時間線',
  'synthesis': '綜合報告(心智模型)', 'quality-report': '品質稽核報告',
};

function renderResearch(files) {
  const panel = $('#panel-research');
  const ul = $('#research-list');
  ul.innerHTML = '';
  if (!files.length) { panel.hidden = true; return; }
  panel.hidden = false;
  for (const f of files) {
    const key = f.replace(/\.md$/, '');
    const label = RESEARCH_LABELS[key] || key;
    const dim = /^\d/.test(key) ? key : null; // 可重跑的維度(數字開頭)
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="rl-name">📄 ${esc(label)}</span>
      ${dim ? `<button class="btn btn-ghost btn-small rl-redo" data-dim="${esc(dim)}" title="重跑此維度並重建人物檔案">重跑</button>` : ''}
      <button class="btn btn-ghost btn-small rl-view" data-file="${esc(f)}">檢視</button>`;
    li.querySelector('.rl-view').addEventListener('click', () => openResearch(f, label));
    const redo = li.querySelector('.rl-redo');
    if (redo) redo.addEventListener('click', () => regenerateDimension(redo.dataset.dim, label));
    ul.appendChild(li);
  }
}

async function openResearch(file, label) {
  try {
    const { content } = await api(`/api/characters/${encodeURIComponent(state.current.id)}/research/${encodeURIComponent(file)}`);
    $('#research-title').textContent = label;
    $('#research-body').innerHTML = renderMd(content);
    $('#modal-research').showModal();
  } catch (err) {
    toast(err.message, true);
  }
}

async function regenerateDimension(dim, label) {
  if (!confirm(`重跑維度「${label}」?會重新分析此維度,並據此重建綜合報告與人物檔案。`)) return;
  try {
    const { jobId } = await api(`/api/characters/${encodeURIComponent(state.current.id)}/regenerate-dimension`, {
      method: 'POST', body: { dimension: dim },
    });
    const chip = $('#char-status');
    chip.textContent = STATUS_LABEL.distilling;
    chip.className = 'status-chip distilling';
    attachJobStream(jobId);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderFiles(files) {
  const ul = $('#file-list');
  ul.innerHTML = '';
  $('#dropzone-hint').style.display = files.length ? 'none' : '';
  for (const f of files) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="f-name">📄 ${esc(f.name)}</span>
      <span class="f-size">${fmtSize(f.size)}</span>
      <button class="f-del" title="刪除">✕</button>`;
    li.querySelector('.f-del').addEventListener('click', async () => {
      if (!confirm(`刪除 ${f.name}?`)) return;
      const list = await api(`/api/characters/${encodeURIComponent(state.current.id)}/files/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
      renderFiles(list);
      refreshCharacters();
    });
    ul.appendChild(li);
  }
}

async function uploadFiles(fileList) {
  if (!fileList.length) return;
  const fd = new FormData();
  for (const f of fileList) fd.append('files', f);
  try {
    const list = await api(`/api/characters/${encodeURIComponent(state.current.id)}/files`, { method: 'POST', body: fd });
    renderFiles(list);
    refreshCharacters();
    toast(`已加入 ${fileList.length} 份文件`);
  } catch (err) {
    toast(err.message, true);
  }
}

// ---------- 蒸餾進度 ----------

function closeJobStream() {
  if (state.jobSource) { state.jobSource.close(); state.jobSource = null; }
}

function initFurnace() {
  const furnace = $('#furnace');
  furnace.hidden = false;
  const phasesEl = $('#furnace-phases');
  phasesEl.innerHTML = PHASES.map(
    (p) => `<span class="phase-step" data-phase="${p.key}">${p.label}</span>`
  ).join('');
  $('#dim-grid').innerHTML = '';
  for (const id of ['#corpus-note', '#quality-note']) {
    const n = $(id);
    n.textContent = '';
    n.className = 'corpus-note';
  }
  const msg = $('#furnace-msg');
  msg.textContent = '正在點火⋯';
  msg.className = 'furnace-msg';
}

function attachJobStream(jobId) {
  closeJobStream();
  initFurnace();
  const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream`);
  state.jobSource = es;

  es.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    handleJobEvent(evt);
  };
  es.onerror = () => {
    // CONNECTING:瀏覽器仍在自動重連,不處理
    // CLOSED:連線永久失敗(如伺服器重啟後工作已遺失回 404)
    if (es.readyState === EventSource.CLOSED && state.jobSource === es) {
      closeJobStream();
      const msg = $('#furnace-msg');
      msg.textContent = '連線中斷,無法取得蒸餾進度。請重新整理頁面確認最新狀態。';
      msg.className = 'furnace-msg error';
      refreshCharacters();
    }
  };
}

function handleJobEvent(evt) {
  const msg = $('#furnace-msg');
  if (evt.type === 'phase') {
    const cur = PHASES.findIndex((p) => p.key === evt.phase);
    // 子階段(如 'refine' 不在五個里程碑內)只更新文字,不重算進度點,以免把已完成的點清空
    if (cur > -1) {
      for (const el of document.querySelectorAll('.phase-step')) {
        const idx = PHASES.findIndex((p) => p.key === el.dataset.phase);
        el.classList.toggle('active', el.dataset.phase === evt.phase);
        el.classList.toggle('done', idx > -1 && idx < cur);
      }
    }
    msg.textContent = `進行中:${evt.label}`;
  } else if (evt.type === 'corpus') {
    // 寫入專屬的持久列,避免被後續 phase 事件覆蓋
    const note = $('#corpus-note');
    const parts = [`已載入 ${evt.files.length} 份文件,共 ${evt.totalChars.toLocaleString()} 字`];
    if (evt.truncated) parts.push('⚠ 語料超出上限,已按比例截斷');
    if (evt.skipped?.length) parts.push(`跳過:${evt.skipped.map((s) => s.name).join('、')}`);
    note.textContent = parts.join(';');
    note.classList.toggle('error', Boolean(evt.truncated || evt.skipped?.length));
  } else if (evt.type === 'dimension') {
    let card = document.querySelector(`.dim-card[data-key="${evt.key}"]`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'dim-card';
      card.dataset.key = evt.key;
      $('#dim-grid').appendChild(card);
    }
    card.textContent = evt.label + (evt.state === 'cached' ? '(重用)' : '');
    const cls = evt.state === 'start' ? 'running'
      : evt.state === 'done' || evt.state === 'cached' ? 'done' : 'failed';
    card.className = 'dim-card ' + cls;
    if (evt.state === 'failed') card.title = evt.message || '';
  } else if (evt.type === 'quality') {
    // 品質稽核結果:寫入專屬列,不覆蓋語料截斷/跳過的警告
    const note = $('#quality-note');
    const bits = [`品質稽核第 ${evt.round} 輪:${evt.pass ? '✓ 通過' : '✗ 未通過,將重新提煉'}`];
    if (evt.untraceableQuotes?.length) bits.push(`查無出處引語 ${evt.untraceableQuotes.length} 句`);
    if (evt.fakeModels?.length) bits.push(`偽心智模型 ${evt.fakeModels.length} 個`);
    if (evt.issues?.length) bits.push(evt.issues[0]);
    note.textContent = bits.join(';');
    note.classList.toggle('error', !evt.pass);
  } else if (evt.type === 'synthesis') {
    // 綜合完成,無需特別 UI(phase 事件已顯示)
  } else if (evt.type === 'done') {
    for (const el of document.querySelectorAll('.phase-step')) el.classList.replace('active', 'done') || el.classList.add('done');
    msg.textContent = '🎉 ' + evt.message;
    closeJobStream();
    toast('蒸餾完成!');
    // 僅在仍停留於人物頁時才重整;若使用者已進入對話,不可把他拉走(會清掉 state.chat)
    if (state.current && !$('#view-character').hidden) {
      openCharacter(state.current.id);
    } else {
      refreshCharacters();
    }
  } else if (evt.type === 'error') {
    msg.textContent = '蒸餾失敗:' + evt.message;
    msg.className = 'furnace-msg error';
    closeJobStream();
    refreshCharacters();
    const chip = $('#char-status');
    chip.textContent = STATUS_LABEL.error;
    chip.className = 'status-chip error';
  }
}

// ---------- 對話 ----------

function renderChats(chats) {
  const ul = $('#chat-list');
  ul.innerHTML = '';
  if (!chats.length) {
    ul.innerHTML = '<li class="empty">還沒有對話。蒸餾完成後,點右上角開始第一場對話。</li>';
    return;
  }
  for (const ch of chats) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="mode-chip${modeChipClass(ch.mode)}">${MODE_LABELS[ch.mode] || '對話'}</span>
      <span class="cl-title">${esc(ch.title)}</span>
      <span class="cl-meta">${ch.messageCount} 則</span>
      <button class="cl-del" title="刪除">✕</button>`;
    li.addEventListener('click', () => openChat(ch.id));
    li.querySelector('.cl-del').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('刪除此對話?')) return;
      await api(`/api/characters/${encodeURIComponent(state.current.id)}/chats/${encodeURIComponent(ch.id)}`, { method: 'DELETE' });
      renderChats(await api(`/api/characters/${encodeURIComponent(state.current.id)}/chats`));
    });
    ul.appendChild(li);
  }
}

// ---------- 議事會 Advisory Board ----------

async function refreshCouncils() {
  const councils = await api('/api/councils');
  const section = $('#council-section');
  const ul = $('#council-list');
  section.hidden = councils.length === 0 && state.characters.filter((c) => c.hasPersona).length < 2;
  ul.innerHTML = '';
  for (const c of councils) {
    const li = document.createElement('div');
    li.className = 'council-card' + (state.council?.id === c.id ? ' active' : '');
    li.innerHTML = `
      <div class="cc-name">${esc(c.title)}</div>
      <div class="cc-meta">${c.participants.map((p) => esc(p.name)).join(' · ')}</div>`;
    li.addEventListener('click', () => openCouncil(c.id).catch((err) => toast(err.message, true)));
    ul.appendChild(li);
  }
}

function personaColor(council, personaId) {
  if (personaId === '__moderator') return 'var(--gold)'; // 主持人固定鎏金色
  const idx = council.participants.findIndex((p) => p.id === personaId);
  return PERSONA_COLORS[(idx < 0 ? 0 : idx) % PERSONA_COLORS.length];
}

function appendCouncilMessage(role, content, personaName, color) {
  const box = $('#council-messages');
  const div = document.createElement('div');
  if (role === 'user') {
    div.className = 'msg msg-user';
    div.innerHTML = `<div class="msg-role">你</div><div class="msg-bubble">${esc(content).replace(/\n/g, '<br>')}</div>`;
  } else {
    div.className = 'msg msg-assistant';
    div.innerHTML = `<div class="msg-role" style="color:${color}">${esc(personaName)}</div>
      <div class="msg-bubble" style="border-color:${color}44"><div class="md-body">${renderMd(content)}</div></div>`;
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

async function openCouncil(councilId) {
  state.councilCtrl?.abort(); // 中止上一個議事會仍在跑的串流
  state.councilCtrl = null;
  const council = await api(`/api/councils/${encodeURIComponent(councilId)}`);
  state.council = council;
  state.chat = null;
  $('#council-name').textContent = council.title;
  $('#council-members').textContent = council.participants.map((p) => p.name).join(' · ');
  const box = $('#council-messages');
  box.innerHTML = '';
  for (const m of council.messages) {
    if (m.role === 'user') appendCouncilMessage('user', m.content);
    else appendCouncilMessage('persona', m.content, m.personaName, personaColor(council, m.personaId));
  }
  showView('view-council');
  refreshCouncils();
  $('#council-input').focus();
  box.scrollTop = box.scrollHeight;
}

async function sendCouncilMessage() {
  if (state.sending || !state.council) return;
  const input = $('#council-input');
  const content = input.value.trim();
  if (!content) return;
  const council = state.council;          // 綁定本次送出的議事會
  const ctrl = new AbortController();
  state.councilCtrl = ctrl;
  state.sending = true;
  $('#btn-council-send').disabled = true;
  input.value = '';
  appendCouncilMessage('user', content);
  const box = $('#council-messages');

  const bubbles = {}; // personaId -> { body, acc }
  try {
    const res = await fetch(`/api/councils/${encodeURIComponent(council.id)}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }), signal: ctrl.signal,
    });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `請求失敗（${res.status}）`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message', data = '';
        for (const l of raw.split('\n')) {
          if (l.startsWith('event: ')) event = l.slice(7).trim();
          else if (l.startsWith('data: ')) data += l.slice(6);
        }
        if (!data) continue;
        let p;
        try { p = JSON.parse(data); } catch { continue; }
        if (council !== state.council) continue; // 已切換到別的議事會/離開:不再寫入畫面
        if (event === 'persona_start') {
          const name = council.participants.find((x) => x.id === p.personaId)?.name || p.name;
          const div = appendCouncilMessage('persona', '', name, personaColor(council, p.personaId));
          bubbles[p.personaId] = { body: div.querySelector('.md-body'), acc: '' };
        } else if (event === 'delta') {
          const b = bubbles[p.personaId];
          if (b) {
            b.acc += p.text;
            const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
            b.body.innerHTML = renderMd(b.acc);
            if (stick) box.scrollTop = box.scrollHeight;
          }
        } else if (event === 'persona_error') {
          const b = bubbles[p.personaId];
          if (b) b.body.innerHTML = `<span style="color:var(--cinnabar-bright)">${esc(p.message)}</span>`;
        } else if (event === 'error') {
          appendError2($('#council-messages'), p.message || '發生錯誤');
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError' && council === state.council) appendError2($('#council-messages'), err.message);
  } finally {
    if (state.councilCtrl === ctrl) state.councilCtrl = null;
    state.sending = false;
    $('#btn-council-send').disabled = false;
    if (council === state.council) input.focus();
  }
}

function appendError2(box, msg) {
  const div = document.createElement('div');
  div.className = 'msg-error';
  div.textContent = msg;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// 自動記憶:離開對話時,若此人物開啟 autoMemory 且這次對話有新訊息,背景送去更新記憶
function maybeAutoRemember() {
  const prev = state.chat;
  if (!prev || !state.current?.autoMemory) return;
  const grew = prev.messages.length - (state.chatBaseline ?? prev.messages.length);
  if (grew < 2) return;
  state.chatBaseline = prev.messages.length; // 防重複觸發
  fetch(`/api/characters/${encodeURIComponent(state.current.id)}/chats/${encodeURIComponent(prev.id)}/remember`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true,
  }).catch(() => {});
}

async function openChat(chatId) {
  maybeAutoRemember(); // 換對話前,先替上一個對話結帳
  const chat = await api(`/api/characters/${encodeURIComponent(state.current.id)}/chats/${encodeURIComponent(chatId)}`);
  state.chat = chat;
  state.chatBaseline = chat.messages.length;
  $('#chat-char-name').textContent = state.current.name;
  const chip = $('#chat-mode-chip');
  chip.textContent = (MODE_LABELS[chat.mode] || '對話') + '模式';
  chip.className = 'mode-chip' + modeChipClass(chat.mode);
  renderConditionsBanner(chat.conditions);
  // 訓練模式:顯示「結束並檢討」;預測模式:顯示「存為預測」
  $('#btn-review').hidden = chat.mode !== 'training';
  $('#btn-save-prediction').hidden = chat.mode !== 'predict';
  const box = $('#messages');
  box.innerHTML = '';
  for (const m of chat.messages) {
    const div = appendMessage(m.role, m.content);
    if (m.role === 'assistant' && m.coach) appendCoach(div, m.coach);
  }
  showView('view-chat');
  $('#composer-input').focus();
  box.scrollTop = box.scrollHeight;
}

// 預測記錄:準度統計文字
function predTallyText(list) {
  if (!list.length) return '還沒有預測記錄。在「預測」模式對話後,按上方「存為預測」把結論記下來,事後回填實際結果。';
  const t = { hit: 0, miss: 0, partial: 0, '': 0 };
  for (const r of list) t[r.verdict] = (t[r.verdict] || 0) + 1;
  const judged = t.hit + t.miss + t.partial;
  const rate = judged ? Math.round(((t.hit + t.partial * 0.5) / judged) * 100) : null;
  return `共 ${list.length} 則｜命中 ${t.hit}・部分 ${t.partial}・落空 ${t.miss}・待驗證 ${t['']}${rate != null ? `｜準度約 ${rate}%` : ''}`;
}

function renderPredictions(id, list) {
  $('#predictions-tally').textContent = predTallyText(list);
  const box = $('#predictions-list');
  box.innerHTML = '';
  const patch = async (pid, body) => {
    try { await api(`/api/characters/${encodeURIComponent(id)}/predictions/${encodeURIComponent(pid)}`, { method: 'PATCH', body }); }
    catch (err) { toast(err.message, true); }
  };
  for (const r of list) {
    const div = document.createElement('div');
    div.className = 'prediction-item verdict-' + (r.verdict || 'none');
    div.innerHTML = `
      <div class="pred-head">
        <span class="pred-date">${esc(new Date(r.at).toLocaleString('zh-TW'))}</span>
        <select class="pred-verdict">
          <option value="">待驗證</option>
          <option value="hit">命中</option>
          <option value="partial">部分</option>
          <option value="miss">落空</option>
        </select>
        <button class="btn btn-ghost btn-small pred-del">刪除</button>
      </div>
      ${r.situation ? `<div class="pred-situation">情境:${esc(r.situation)}</div>` : ''}
      <div class="pred-body md-body">${renderMd(r.prediction)}</div>
      <textarea class="pred-outcome" placeholder="實際發生了什麼?(回填後即計入準度)"></textarea>`;
    const sel = div.querySelector('.pred-verdict');
    sel.value = r.verdict || '';
    div.querySelector('.pred-outcome').value = r.outcome || '';
    sel.addEventListener('change', () => {
      r.verdict = sel.value;
      div.className = 'prediction-item verdict-' + (r.verdict || 'none');
      $('#predictions-tally').textContent = predTallyText(list);
      patch(r.id, { verdict: r.verdict });
    });
    div.querySelector('.pred-outcome').addEventListener('change', (e) => {
      r.outcome = e.target.value;
      patch(r.id, { outcome: r.outcome });
    });
    div.querySelector('.pred-del').addEventListener('click', async () => {
      if (!confirm('刪除這則預測?')) return;
      try {
        await api(`/api/characters/${encodeURIComponent(id)}/predictions/${encodeURIComponent(r.id)}`, { method: 'DELETE' });
        renderPredictions(id, list.filter((x) => x.id !== r.id));
      } catch (err) { toast(err.message, true); }
    });
    box.appendChild(div);
  }
}

// 結束訓練:顯示/串流一份檢討報告到彈窗
async function runReview(force = false) {
  if (!state.chat || state.chat.mode !== 'training' || state.reviewing) return;
  const chat = state.chat;                 // 綁定本次檢討的對話
  const bodyEl = $('#review-body');
  const regenBtn = $('#btn-review-regen');
  // 已有上次檢討且非強制重跑:直接顯示,不再花一次呼叫
  if (!force && chat.review?.content) {
    bodyEl.innerHTML = renderMd(chat.review.content);
    regenBtn.hidden = false;
    $('#modal-review').showModal();
    return;
  }
  bodyEl.innerHTML = '<span class="muted">教練正在回顧整場對話⋯</span>';
  regenBtn.hidden = true;
  $('#modal-review').showModal();
  const ctrl = new AbortController();
  state.reviewCtrl = ctrl;
  state.reviewing = true;
  $('#btn-review').disabled = true;
  let acc = '';
  const alive = () => chat === state.chat && state.reviewCtrl === ctrl; // 仍是同一對話、同一次檢討
  try {
    const res = await fetch(
      `/api/characters/${encodeURIComponent(state.current.id)}/chats/${encodeURIComponent(chat.id)}/review`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: ctrl.signal }
    );
    const ctype = res.headers.get('content-type') || '';
    if (!res.ok || !ctype.includes('text/event-stream')) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `請求失敗（${res.status}）`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message', data = '';
        for (const l of raw.split('\n')) {
          if (l.startsWith('event: ')) event = l.slice(7).trim();
          else if (l.startsWith('data: ')) data += l.slice(6);
        }
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        if (event === 'delta') {
          acc += payload.text;
          if (alive()) bodyEl.innerHTML = renderMd(acc);
        } else if (event === 'error') {
          if (alive()) bodyEl.innerHTML = `<span style="color:var(--cinnabar-bright)">${esc(payload.message)}</span>`;
        }
      }
    }
    if (acc.trim()) {
      chat.review = { content: acc };       // 記在記憶體,重開此對話可直接看
      if (alive()) regenBtn.hidden = false;
    } else if (alive()) {
      bodyEl.innerHTML = '<span class="muted">沒有收到檢討內容,請重試。</span>';
    }
  } catch (err) {
    if (err.name !== 'AbortError' && alive()) bodyEl.innerHTML = `<span style="color:var(--cinnabar-bright)">${esc(err.message)}</span>`;
  } finally {
    if (state.reviewCtrl === ctrl) state.reviewCtrl = null;
    state.reviewing = false;
    $('#btn-review').disabled = false;
  }
}

// 關閉檢討彈窗:中止仍在跑的串流,避免背景繼續寫入
function closeReview() {
  state.reviewCtrl?.abort();
  state.reviewCtrl = null;
  $('#modal-review').close();
}

// 在某則助理訊息下方掛上一條教練點評
function appendCoach(afterDiv, text) {
  const box = $('#messages');
  const div = document.createElement('div');
  div.className = 'coach-note';
  div.innerHTML = `<span class="coach-badge">💬 教練</span><span class="coach-text">${esc(text)}</span>`;
  if (afterDiv && afterDiv.nextSibling) box.insertBefore(div, afterDiv.nextSibling);
  else box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function renderConditionsBanner(cond) {
  const banner = $('#conditions-banner');
  const parts = [];
  if (cond?.scenario) parts.push(`情境:${cond.scenario}`);
  if (cond?.timepoint) parts.push(`時間點:${cond.timepoint}`);
  if (cond?.interlocutor) parts.push(`你的身份:${cond.interlocutor}`);
  if (cond?.style) parts.push(`表達:${cond.style}`);
  if (cond?.extra) parts.push(cond.extra);
  banner.textContent = parts.join(' ｜ ');
  banner.hidden = !parts.length;
  $('#btn-show-conditions').style.display = parts.length ? '' : 'none';
}

// ---------- 語音(Web Speech API,純前端、零成本、離線)----------
const TTS_OK = typeof window !== 'undefined' && 'speechSynthesis' in window;
const SR_CLASS = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

function speak(text) {
  if (!TTS_OK || !text || !text.trim()) return;
  window.speechSynthesis.cancel(); // 先停掉上一段
  const u = new SpeechSynthesisUtterance(text.slice(0, 4000));
  u.lang = 'zh-TW';
  const voices = window.speechSynthesis.getVoices();
  const zh = voices.find((v) => /zh[-_]?TW|Taiwan/i.test(v.lang) || /國語|中文|Taiwan/i.test(v.name))
    || voices.find((v) => /^zh/i.test(v.lang));
  if (zh) u.voice = zh;
  window.speechSynthesis.speak(u);
}

function setupVoice() {
  // TTS:朗讀鈕用事件委派(訊息會動態新增)
  if (TTS_OK) {
    $('#messages').addEventListener('click', (e) => {
      const b = e.target.closest('.speak-btn');
      if (!b) return;
      const body = b.closest('.msg')?.querySelector('.md-body');
      if (body) speak(body.textContent);
    });
    // 有些瀏覽器 voices 非同步載入,先觸發一次
    window.speechSynthesis.getVoices();
  }
  // STT:語音輸入
  const mic = $('#btn-mic');
  if (!SR_CLASS) return; // 不支援就維持隱藏
  mic.hidden = false;
  const recog = new SR_CLASS();
  recog.lang = 'zh-TW';
  recog.interimResults = true;
  recog.continuous = false;
  let recognizing = false;
  let base = '';
  recog.onresult = (e) => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) final += t; else interim += t;
    }
    $('#composer-input').value = base + final + interim;
  };
  const stop = () => { recognizing = false; mic.classList.remove('recording'); };
  recog.onend = stop;
  recog.onerror = stop;
  mic.addEventListener('click', () => {
    if (recognizing) { recog.stop(); return; }
    const cur = $('#composer-input').value;
    base = cur ? cur + ' ' : '';
    recognizing = true;
    mic.classList.add('recording');
    try { recog.start(); } catch { stop(); }
  });
}

function appendMessage(role, content, streaming = false) {
  const box = $('#messages');
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;
  const roleName = role === 'user' ? '你' : state.current.name;
  const speakBtn = role === 'assistant' && TTS_OK ? ' <button class="speak-btn" title="朗讀">🔊</button>' : '';
  div.innerHTML = `
    <div class="msg-role">${esc(roleName)}${speakBtn}</div>
    <div class="msg-bubble${streaming ? ' streaming' : ''}">${role === 'assistant' ? `<div class="md-body">${renderMd(content)}</div>` : esc(content).replace(/\n/g, '<br>')}</div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function appendError(msg) {
  const box = $('#messages');
  const div = document.createElement('div');
  div.className = 'msg-error';
  div.textContent = msg;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

async function sendMessage() {
  if (state.sending || !state.chat) return;
  const input = $('#composer-input');
  const content = input.value.trim();
  if (!content) return;
  const chat = state.chat;               // 綁定本次送出的對話,避免中途切換錯置
  const ctrl = new AbortController();
  state.sendCtrl = ctrl;
  state.sending = true;
  $('#btn-send').disabled = true;
  input.value = '';
  const userDiv = appendMessage('user', content);

  const holder = appendMessage('assistant', '', true);
  const bubble = holder.querySelector('.msg-bubble');
  const body = bubble.querySelector('.md-body');
  let acc = '';
  const box = $('#messages');

  const rollback = () => {
    userDiv.remove();
    holder.remove();
    if (!input.value) input.value = content; // 還原輸入,不覆蓋送出後新打的字
  };

  try {
    const res = await fetch(
      `/api/characters/${encodeURIComponent(state.current.id)}/chats/${encodeURIComponent(chat.id)}/messages`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }), signal: ctrl.signal }
    );
    const ctype = res.headers.get('content-type') || '';
    if (!res.ok || !ctype.includes('text/event-stream')) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `請求失敗（${res.status}）`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let failed = null;
    let finished = false;
    let coachText = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = 'message', data = '';
        for (const l of raw.split('\n')) {
          if (l.startsWith('event: ')) event = l.slice(7).trim();
          else if (l.startsWith('data: ')) data += l.slice(6);
        }
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        if (event === 'delta') {
          acc += payload.text;
          if (bubble.isConnected) {
            const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
            body.innerHTML = renderMd(acc);
            if (stick) box.scrollTop = box.scrollHeight;
          }
        } else if (event === 'coach') {
          coachText = payload.text;
          if (chat === state.chat) appendCoach(holder, coachText);
        } else if (event === 'error') {
          failed = payload.message || '發生錯誤';
        } else if (event === 'done') {
          finished = true;
        }
      }
    }
    bubble.classList.remove('streaming');
    // 完成的訊息一律寫入其所屬對話(即使使用者已切走)
    if (failed) {
      rollback();
      if (chat === state.chat) appendError(failed);
      else toast(failed, true);
    } else if (!finished) {
      // 串流中斷但沒收到 done:回覆不完整,以磁碟版本為準重新同步
      rollback();
      if (chat === state.chat) appendError('連線中斷,回覆未完成');
    } else if (!acc) {
      rollback();
      if (chat === state.chat) appendError('沒有收到回應');
    } else {
      chat.messages.push({ role: 'user', content });
      chat.messages.push({ role: 'assistant', content: acc, ...(coachText ? { coach: coachText } : {}) });
    }
  } catch (err) {
    bubble.classList.remove('streaming');
    if (err.name === 'AbortError') {
      rollback();               // 使用者切走或關閉:靜默回滾
    } else {
      rollback();
      if (chat === state.chat) appendError(err.message);
      else toast(err.message, true);
    }
  } finally {
    if (state.sendCtrl === ctrl) state.sendCtrl = null;
    state.sending = false;
    $('#btn-send').disabled = false;
    if (chat === state.chat) input.focus();
  }
}

// ---------- 關係儀表板 ----------

const DASH_C_SUBJECT = 'var(--jade)';   // 此人物
const DASH_C_OTHER = 'var(--gold)';     // 對話的另一方

function dashBars(rows, labelEvery = 1) {
  // rows: [{label, a, b}] → 分組長條(a=subject, b=other)
  const max = Math.max(1, ...rows.map((r) => Math.max(r.a, r.b)));
  const bw = 9, gap = 4, group = bw * 2 + gap + 12, H = 150, base = H - 24;
  const W = rows.length * group + 30;
  let out = `<svg viewBox="0 0 ${W} ${H}" class="dash-svg" style="min-width:${Math.min(W, 900)}px">`;
  rows.forEach((r, i) => {
    const x = 16 + i * group;
    const ha = Math.round((r.a / max) * (base - 18));
    const hb = Math.round((r.b / max) * (base - 18));
    out += `<rect x="${x}" y="${base - ha}" width="${bw}" height="${ha}" rx="2" fill="${DASH_C_SUBJECT}"><title>${esc(r.label)}:${r.a}</title></rect>`;
    out += `<rect x="${x + bw + gap}" y="${base - hb}" width="${bw}" height="${hb}" rx="2" fill="${DASH_C_OTHER}"><title>${esc(r.label)}:${r.b}</title></rect>`;
    if (i % labelEvery === 0) out += `<text x="${x + bw + gap / 2}" y="${H - 8}" font-size="9" fill="currentColor" opacity="0.55" text-anchor="middle">${esc(r.label)}</text>`;
  });
  return out + '</svg>';
}

function dashArcLine(months) {
  // 情感弧線:-2..+2 折線,點上帶當月基調
  if (!months?.length) return '';
  const step = 46, W = months.length * step + 40, H = 130, mid = 62, scale = 24;
  const pts = months.map((m, i) => [24 + i * step, mid - m.valence * scale]);
  let out = `<svg viewBox="0 0 ${W} ${H}" class="dash-svg" style="min-width:${Math.min(W, 900)}px">`;
  out += `<line x1="12" y1="${mid}" x2="${W - 12}" y2="${mid}" stroke="currentColor" stroke-opacity="0.15"/>`;
  out += `<polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="${DASH_C_SUBJECT}" stroke-width="2"/>`;
  months.forEach((m, i) => {
    const [x, y] = pts[i];
    out += `<circle cx="${x}" cy="${y}" r="4" fill="${m.valence >= 0 ? DASH_C_SUBJECT : 'var(--cinnabar-bright)'}"><title>${esc(m.ym)}(${m.valence > 0 ? '+' : ''}${m.valence})${esc(m.tone)}</title></circle>`;
    out += `<text x="${x}" y="${H - 6}" font-size="9" fill="currentColor" opacity="0.55" text-anchor="middle">${esc(m.ym.slice(2))}</text>`;
  });
  return out + '</svg>';
}

function renderDashboard(a) {
  const S = esc(a.subjectLabel), O = esc(a.otherLabel);
  const t = a.totals;
  const pct = (x, y) => (x + y ? Math.round((x / (x + y)) * 100) : 0);
  const avgLen = (chars, n) => (n ? Math.round(chars / n) : 0);
  const legend = `<span class="dash-key"><i style="background:${DASH_C_SUBJECT}"></i>${S}</span><span class="dash-key"><i style="background:${DASH_C_OTHER}"></i>${O}</span>`;

  const cards = [
    ['訊息總數', `${(t.subject + t.other).toLocaleString()}`, `${S} ${t.subject.toLocaleString()}|${O} ${t.other.toLocaleString()}`],
    ['時間範圍', `${a.range.from || '—'} → ${a.range.to || '—'}`, `活躍 ${a.range.activeDays} 天`],
    ['誰先開場', `${S} ${pct(a.initiations.subject, a.initiations.other)}%`, `${a.initiations.subject}:${a.initiations.other}(每日第一則)`],
    ['深夜訊息(23–06)', `${a.lateNight.subject + a.lateNight.other}`, `${S} ${a.lateNight.subject}|${O} ${a.lateNight.other}`],
    ['平均訊息長度', `${avgLen(t.subjectChars, t.subject)} / ${avgLen(t.otherChars, t.other)} 字`, `${S} / ${O}`],
    ['貼圖・媒體', `${t.media.toLocaleString()}`, '貼圖、照片、收回訊息等'],
  ].map(([k, v, sub]) => `<div class="dash-card"><div class="dash-k">${k}</div><div class="dash-v">${v}</div><div class="dash-sub">${sub}</div></div>`).join('');

  const monthRows = a.months.map((m) => ({ label: m.ym.slice(2), a: m.subject, b: m.other }));
  const hourRows = Array.from({ length: 24 }, (_, h) => ({ label: String(h), a: a.hourHist.subject[h], b: a.hourHist.other[h] }));

  let arcHtml = `<p class="hint">還沒生成。按右上「✨ 生成情感弧線」,用模型判讀逐月互動基調與轉折點(結果會保存,之後免費重看)。</p>`;
  if (a.arc?.months?.length) {
    arcHtml = dashArcLine(a.arc.months)
      + `<div class="dash-tones">${a.arc.months.map((m) => `<div><b>${esc(m.ym)}</b>(${m.valence > 0 ? '+' : ''}${m.valence})${esc(m.tone)}</div>`).join('')}</div>`
      + (a.arc.turningPoints?.length
        ? `<h4>關鍵轉折</h4><ul class="dash-turns">${a.arc.turningPoints.map((tp) => `<li><b>${esc(tp.date)}</b> — ${esc(tp.label)}</li>`).join('')}</ul>`
        : '');
  }

  $('#dash-body').innerHTML = `
    <div class="dash-cards">${cards}</div>
    <div class="dash-section"><h4>每月訊息量 ${legend}</h4><div class="dash-scroll">${dashBars(monthRows)}</div></div>
    <div class="dash-section"><h4>一天中的什麼時候在聊 ${legend}</h4><div class="dash-scroll">${dashBars(hourRows, 2)}</div></div>
    <div class="dash-section"><h4>情感弧線</h4>${arcHtml}</div>
    <p class="hint">統計基於語料中的聊天匯出檔(${a.files.map((f) => esc(f.name)).join('、') || '無'})${a.skipped.length ? `;非聊天格式已略過:${a.skipped.map(esc).join('、')}` : ''}。這些是「紀錄的形狀」,不是關係的全部——線下的相處、沒說出口的部分,都不在這裡。</p>`;
}

async function openDashboard() {
  if (!state.current) return;
  $('#dash-title').textContent = `關係儀表板 · ${state.current.name}`;
  $('#dash-body').innerHTML = '<p class="hint">整理語料統計中⋯</p>';
  showView('view-dashboard');
  try {
    state.dash = await api(`/api/characters/${encodeURIComponent(state.current.id)}/analytics`);
    renderDashboard(state.dash);
  } catch (err) {
    $('#dash-body').innerHTML = `<p class="hint" style="color:var(--cinnabar-bright)">${esc(err.message)}</p>`;
  }
}

// ---------- 事件繫結 ----------

function bind() {
  setupVoice(); // 語音(若瀏覽器支援)

  // PWA:保守 SW(network-first,離線才回退快取)
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  // 行動版選單抽屜
  const closeNav = () => document.body.classList.remove('nav-open');
  $('#btn-menu').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  $('#nav-scrim').addEventListener('click', closeNav);
  document.querySelector('.sidebar').addEventListener('click', (e) => {
    if (e.target.closest('button, li, .char-card, .council-card')) closeNav();
  });

  // 登入(密碼保護實例)
  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#login-error');
    errEl.hidden = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: $('#login-password').value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || '登入失敗');
      location.reload();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.hidden = false;
    }
  });

  // 關係儀表板
  $('#btn-dashboard').addEventListener('click', openDashboard);
  $('#btn-dash-back').addEventListener('click', () => showView('view-character'));
  $('#btn-dash-arc').addEventListener('click', async () => {
    const btn = $('#btn-dash-arc');
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '判讀中⋯(約半分鐘)';
    try {
      const arc = await api(`/api/characters/${encodeURIComponent(state.current.id)}/analytics/arc`, { method: 'POST', body: {} });
      if (state.dash) { state.dash.arc = arc; renderDashboard(state.dash); }
      toast('情感弧線已生成並保存');
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });

  // 對話搜尋(防抖;清空即還原列表)
  let searchTimer = null;
  $('#chat-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = $('#chat-search').value.trim();
      const ul = $('#chat-list');
      if (!q) {
        try { renderChats(await api(`/api/characters/${encodeURIComponent(state.current.id)}/chats`)); } catch { /* 忽略 */ }
        return;
      }
      try {
        const hits = await api(`/api/characters/${encodeURIComponent(state.current.id)}/chat-search?q=${encodeURIComponent(q)}`);
        ul.innerHTML = hits.length ? '' : '<li class="muted">沒有符合的對話</li>';
        for (const h of hits) {
          const li = document.createElement('li');
          li.innerHTML = `<span class="mode-chip${modeChipClass(h.mode)}">${MODE_LABELS[h.mode] || '對話'}</span>
            <span class="cl-title">${esc(h.title)}<br><small class="cl-snippet">${esc(h.snippet)}</small></span>`;
          li.addEventListener('click', () => openChat(h.chatId));
          ul.appendChild(li);
        }
      } catch (err) { toast(err.message, true); }
    }, 250);
  });

  // 匯出對話為 Markdown
  $('#btn-export-chat').addEventListener('click', () => {
    const c = state.chat;
    if (!c) return;
    const lines = [`# ${state.current.name} · ${c.title}`, `模式:${MODE_LABELS[c.mode] || c.mode}｜建立:${new Date(c.createdAt).toLocaleString('zh-TW')}`, ''];
    for (const m of c.messages) {
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      lines.push(`**${m.role === 'user' ? '你' : state.current.name}**:`, m.content, '');
      if (m.coach) lines.push(`> 💬 教練:${m.coach}`, '');
    }
    if (c.review?.content) lines.push('---', '', c.review.content, '');
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const aEl = document.createElement('a');
    aEl.href = url;
    aEl.download = `${state.current.name}-${c.title}.md`.replace(/[\\/:*?"<>|]/g, '_');
    document.body.appendChild(aEl);
    aEl.click();
    aEl.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // 成長日誌
  const renderJournal = async () => {
    const list = $('#journal-list');
    const entries = await api('/api/journal');
    list.innerHTML = entries.length ? '' : '<p class="muted">還沒有日誌。每次對話後記一行,累積起來就是你的軌跡。</p>';
    for (const en of entries) {
      const div = document.createElement('div');
      div.className = 'journal-item';
      div.innerHTML = `<div class="journal-meta">${esc(new Date(en.at).toLocaleString('zh-TW'))}${en.characterName ? `・與 ${esc(en.characterName)}` : ''}${en.mode ? `・${esc(MODE_LABELS[en.mode] || en.mode)}` : ''}<button class="cl-del" title="刪除">✕</button></div>
        <div class="journal-text">${esc(en.text)}</div>`;
      div.querySelector('.cl-del').addEventListener('click', async () => {
        if (!confirm('刪除這則日誌?')) return;
        await api(`/api/journal/${encodeURIComponent(en.id)}`, { method: 'DELETE' });
        renderJournal();
      });
      list.appendChild(div);
    }
  };
  const openJournal = async (fromChat) => {
    $('#journal-compose').hidden = !fromChat;
    $('#journal-text').value = '';
    try { await renderJournal(); } catch (err) { toast(err.message, true); return; }
    $('#modal-journal').showModal();
  };
  $('#btn-journal').addEventListener('click', () => openJournal(false));
  $('#btn-journal-here').addEventListener('click', () => openJournal(true));
  $('#btn-journal-suggest').addEventListener('click', async () => {
    if (!state.chat) return;
    const btn = $('#btn-journal-suggest');
    btn.disabled = true;
    try {
      const { suggestion } = await api(`/api/characters/${encodeURIComponent(state.current.id)}/chats/${encodeURIComponent(state.chat.id)}/journal-suggest`, { method: 'POST', body: {} });
      $('#journal-text').value = suggestion;
    } catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; }
  });
  $('#btn-journal-save').addEventListener('click', async () => {
    const text = $('#journal-text').value.trim();
    if (!text) { toast('先寫一句吧', true); return; }
    try {
      await api('/api/journal', {
        method: 'POST',
        body: { text, characterId: state.current?.id, characterName: state.current?.name, mode: state.chat?.mode },
      });
      $('#journal-text').value = '';
      await renderJournal();
      toast('記下了');
    } catch (err) { toast(err.message, true); }
  });

  // A/B 比較
  let abBusy = false;
  $('#btn-ab').addEventListener('click', () => {
    if (!state.chat) return;
    $('#ab-input-a').value = $('#composer-input').value.trim();
    $('#ab-input-b').value = '';
    $('#ab-panes').hidden = true;
    $('#ab-reply-a').innerHTML = '';
    $('#ab-reply-b').innerHTML = '';
    $('#btn-ab-adopt-a').disabled = true;
    $('#btn-ab-adopt-b').disabled = true;
    $('#modal-ab').showModal();
  });
  $('#btn-ab-run').addEventListener('click', async () => {
    if (abBusy || !state.chat) return;
    const a = $('#ab-input-a').value.trim();
    const b = $('#ab-input-b').value.trim();
    if (!a || !b) { toast('兩種說法都要填', true); return; }
    const chat = state.chat;
    abBusy = true;
    $('#btn-ab-run').disabled = true;
    $('#ab-panes').hidden = false;
    const pane = { a: $('#ab-reply-a'), b: $('#ab-reply-b') };
    const acc = { a: '', b: '' };
    const final = { a: null, b: null };
    pane.a.innerHTML = pane.b.innerHTML = '<span class="muted">生成中⋯</span>';
    try {
      const res = await fetch(
        `/api/characters/${encodeURIComponent(state.current.id)}/chats/${encodeURIComponent(chat.id)}/ab`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a, b }) }
      );
      const ctype = res.headers.get('content-type') || '';
      if (!res.ok || !ctype.includes('text/event-stream')) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `請求失敗（${res.status}）`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message', data = '';
          for (const l of raw.split('\n')) {
            if (l.startsWith('event: ')) event = l.slice(7).trim();
            else if (l.startsWith('data: ')) data += l.slice(6);
          }
          if (!data) continue;
          let p;
          try { p = JSON.parse(data); } catch { continue; }
          if (event === 'delta' && pane[p.v]) {
            if (!acc[p.v]) pane[p.v].innerHTML = '';
            acc[p.v] += p.text;
            pane[p.v].innerHTML = renderMd(acc[p.v]);
          } else if (event === 'variant_done' && pane[p.v]) {
            final[p.v] = p.text;
            pane[p.v].innerHTML = renderMd(p.text);
          } else if (event === 'variant_error' && pane[p.v]) {
            pane[p.v].innerHTML = `<span style="color:var(--cinnabar-bright)">${esc(p.message)}</span>`;
          } else if (event === 'error') {
            throw new Error(p.message || '發生錯誤');
          }
        }
      }
      const adopt = (variant) => async () => {
        const content = variant === 'a' ? a : b;
        const reply = final[variant];
        if (!reply) return;
        try {
          await api(`/api/characters/${encodeURIComponent(state.current.id)}/chats/${encodeURIComponent(chat.id)}/ab-commit`, {
            method: 'POST', body: { content, reply },
          });
          chat.messages.push({ role: 'user', content }, { role: 'assistant', content: reply });
          if (chat === state.chat) {
            appendMessage('user', content);
            appendMessage('assistant', reply);
          }
          $('#modal-ab').close();
          toast(`已採用說法 ${variant.toUpperCase()},寫入對話`);
        } catch (err) { toast(err.message, true); }
      };
      $('#btn-ab-adopt-a').onclick = adopt('a');
      $('#btn-ab-adopt-b').onclick = adopt('b');
      $('#btn-ab-adopt-a').disabled = !final.a;
      $('#btn-ab-adopt-b').disabled = !final.b;
    } catch (err) {
      toast(err.message, true);
    } finally {
      abBusy = false;
      $('#btn-ab-run').disabled = false;
    }
  });

  // 語料增量更新
  $('#btn-incremental').addEventListener('click', async () => {
    if (!confirm('用新語料做增量更新?會更新時間線、綜合報告與 persona(舊版會自動存入版本歷史)。')) return;
    try {
      const { jobId } = await api(`/api/characters/${encodeURIComponent(state.current.id)}/distill-incremental`, { method: 'POST', body: {} });
      $('#btn-incremental').hidden = true;
      $('#incremental-hint').hidden = true;
      attachJobStream(jobId);
    } catch (err) { toast(err.message, true); }
  });

  // 新增人物
  const syncConsentRow = () => {
    $('#consent-row').hidden = $('#new-char-subject').value !== 'private';
  };
  const openNewChar = () => {
    $('#form-new-character').reset();
    syncConsentRow();
    $('#modal-new-character').showModal();
  };
  $('#new-char-subject').addEventListener('change', syncConsentRow);
  $('#btn-new-character').addEventListener('click', openNewChar);
  $('#btn-empty-create').addEventListener('click', openNewChar);
  $('#form-new-character').addEventListener('submit', async (e) => {
    e.preventDefault();
    const subjectType = $('#new-char-subject').value;
    if (subjectType === 'private' && !$('#new-char-consent').checked) {
      toast('蒸餾私人對象請先勾選同意確認', true);
      return;
    }
    try {
      const meta = await api('/api/characters', {
        method: 'POST',
        body: {
          name: $('#new-char-name').value,
          note: $('#new-char-note').value,
          aliases: $('#new-char-aliases').value,
          subjectType,
          consentAck: $('#new-char-consent').checked,
          outputLanguage: $('#new-char-lang').value,
        },
      });
      $('#modal-new-character').close();
      await refreshCharacters();
      await openCharacter(meta.id);
      toast(`已建立「${meta.name}」,把文件放進 sources 資料夾吧`);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // 匯入現成人物(GitHub 網址 或 貼上 persona)
  $('#btn-import-character').addEventListener('click', () => {
    $('#form-import').reset();
    $('#import-status').hidden = true;
    $('#modal-import').showModal();
  });
  $('#form-import').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#btn-import-submit');
    const status = $('#import-status');
    const body = {
      url: $('#import-url').value.trim(),
      name: $('#import-name').value.trim(),
      personaText: $('#import-text').value.trim(),
    };
    if (!body.url && !body.personaText) { toast('請填 GitHub 網址,或貼上 persona 文字', true); return; }
    btn.disabled = true;
    status.hidden = false;
    status.textContent = '匯入中⋯正在抓取並建立人物(從 GitHub 拉取可能要幾秒)';
    try {
      let r = await api('/api/import', { method: 'POST', body });
      if (r.needsConfirm) {
        // 注入掃描命中:列出可疑指令,使用者過目後才真正匯入
        const ok = confirm(`這份 persona 含有可疑指令,匯入後會成為系統提示的一部分:\n\n- ${r.warnings.join('\n- ')}\n\n確定仍要匯入?`);
        if (!ok) { status.textContent = '已取消匯入。'; return; }
        status.textContent = '匯入中⋯';
        r = await api('/api/import', { method: 'POST', body: { ...body, force: true } });
      }
      $('#modal-import').close();
      toast(`已匯入「${r.name}」${r.researchCount ? `(含 ${r.researchCount} 份研究檔)` : ''},可以直接對話了`);
      await refreshCharacters();
      await openCharacter(r.id);
    } catch (err) {
      status.textContent = `匯入失敗:${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // persona 檢視 / 編輯
  let personaRaw = '';
  const setPersonaEditMode = (editing) => {
    $('#persona-body').hidden = editing;
    $('#persona-editor').hidden = !editing;
    $('#btn-persona-save').hidden = !editing;
    $('#btn-persona-toggle').textContent = editing ? '預覽' : '切換編輯';
  };
  $('#btn-persona-toggle').addEventListener('click', () => {
    const editing = $('#persona-editor').hidden;
    if (!editing) {
      // 從編輯切回預覽:用編輯器內容重繪
      personaRaw = $('#persona-editor').value;
      $('#persona-body').innerHTML = renderMd(personaRaw);
    } else {
      $('#persona-editor').value = personaRaw;
    }
    setPersonaEditMode(editing);
  });
  $('#btn-persona-save').addEventListener('click', async () => {
    try {
      personaRaw = $('#persona-editor').value;
      await api(`/api/characters/${encodeURIComponent(state.current.id)}/persona`, {
        method: 'PUT', body: { persona: personaRaw },
      });
      $('#persona-body').innerHTML = renderMd(personaRaw);
      setPersonaEditMode(false);
      toast('人物檔案已儲存,下次對話即用新版');
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#btn-persona-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(personaRaw);
      toast('已複製人物檔案,可直接貼進 Claude / ChatGPT 當系統提示詞');
    } catch {
      toast('瀏覽器擋了複製,請切到編輯模式手動選取', true);
    }
  });
  $('#btn-persona-download').addEventListener('click', () => {
    const name = (state.current?.name || 'persona').replace(/[\\/:*?"<>|]/g, '_');
    const blob = new Blob([personaRaw], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}-persona.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('#btn-edit-persona').addEventListener('click', async () => {
    try {
      const { persona } = await api(`/api/characters/${encodeURIComponent(state.current.id)}/persona`);
      personaRaw = persona;
      $('#persona-body').innerHTML = renderMd(persona);
      $('#persona-editor').value = persona;
      setPersonaEditMode(false);
      $('#modal-persona').showModal();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // 跨對話記憶:檢視 / 編輯 / 清空
  $('#btn-view-memory').addEventListener('click', async () => {
    try {
      const { memory } = await api(`/api/characters/${encodeURIComponent(state.current.id)}/memory`);
      $('#memory-editor').value = memory || '';
      $('#memory-auto').checked = Boolean(state.current?.autoMemory);
      $('#modal-memory').showModal();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#memory-auto').addEventListener('change', async (e) => {
    try {
      await api(`/api/characters/${encodeURIComponent(state.current.id)}`, {
        method: 'PATCH', body: { autoMemory: e.target.checked },
      });
      state.current.autoMemory = e.target.checked;
      toast(e.target.checked ? '已開啟:離開對話時自動更新記憶' : '已關閉自動記憶');
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast(err.message, true);
    }
  });
  $('#btn-memory-save').addEventListener('click', async () => {
    try {
      await api(`/api/characters/${encodeURIComponent(state.current.id)}/memory`, {
        method: 'PUT', body: { memory: $('#memory-editor').value },
      });
      $('#modal-memory').close();
      toast('記憶已儲存,下次對話就會帶著它');
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#btn-memory-clear').addEventListener('click', async () => {
    if (!confirm('清空此人物的跨對話記憶?此動作無法復原。')) return;
    try {
      await api(`/api/characters/${encodeURIComponent(state.current.id)}/memory`, { method: 'PUT', body: { memory: '' } });
      $('#memory-editor').value = '';
      toast('已清空記憶');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // persona 版本歷史
  $('#btn-persona-versions').addEventListener('click', async () => {
    const id = state.current.id;
    const ul = $('#versions-list');
    const prev = $('#versions-preview');
    prev.innerHTML = '<span class="muted">點左側的時間可預覽該版本</span>';
    try {
      const versions = await api(`/api/characters/${encodeURIComponent(id)}/persona-versions`);
      if (!versions.length) {
        ul.innerHTML = '<li class="muted">還沒有歷史版本——之後每次編輯 / 重蒸餾前會自動存一份。</li>';
      } else {
        ul.innerHTML = '';
        for (const v of versions) {
          const li = document.createElement('li');
          li.innerHTML = `<button class="ver-time">${esc(new Date(v.at).toLocaleString('zh-TW'))}</button>
            <span class="ver-size">${(v.bytes / 1024).toFixed(1)}KB</span>
            <button class="btn btn-ghost btn-small ver-restore">回溯</button>`;
          li.querySelector('.ver-time').addEventListener('click', async () => {
            try {
              const { content } = await api(`/api/characters/${encodeURIComponent(id)}/persona-versions/${encodeURIComponent(v.name)}`);
              prev.innerHTML = renderMd(content);
            } catch (err) { prev.innerHTML = `<span style="color:var(--cinnabar-bright)">${esc(err.message)}</span>`; }
          });
          li.querySelector('.ver-restore').addEventListener('click', async () => {
            if (!confirm(`回溯到「${new Date(v.at).toLocaleString('zh-TW')}」這一版?目前這份會先存成新的歷史版本,可再還原回來。`)) return;
            try {
              await api(`/api/characters/${encodeURIComponent(id)}/persona-versions/${encodeURIComponent(v.name)}/restore`, { method: 'POST', body: {} });
              $('#modal-versions').close();
              toast('已回溯,persona 已更新');
            } catch (err) { toast(err.message, true); }
          });
          ul.appendChild(li);
        }
      }
      $('#modal-versions').showModal();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // 偵測發言者
  $('#btn-detect-speakers').addEventListener('click', async () => {
    try {
      const speakers = await api(`/api/characters/${encodeURIComponent(state.current.id)}/speakers`);
      const box = $('#speaker-chips');
      box.innerHTML = '';
      if (!speakers.length) { toast('語料中沒有偵測到明顯的發言者標記', true); return; }
      for (const s of speakers) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'speaker-chip';
        chip.textContent = `${s.name} (${s.count})`;
        chip.addEventListener('click', () => {
          const cur = $('#char-aliases-input').value.split(/[,、]/).map((x) => x.trim()).filter(Boolean);
          if (!cur.includes(s.name)) cur.push(s.name);
          $('#char-aliases-input').value = cur.join(', ');
          chip.classList.add('picked');
        });
        box.appendChild(chip);
      }
      toast('點選發言者加入別名,記得按「儲存」');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // 試算 + 備份
  $('#btn-estimate').addEventListener('click', async () => {
    try {
      const gear = $('#gear-select').value;
      const est = await api(`/api/characters/${encodeURIComponent(state.current.id)}/estimate?gear=${gear}`);
      const box = $('#estimate-box');
      const k = (n) => `${(n / 1000).toFixed(0)}K`;
      const parts = [
        `語料 ${est.totalChars.toLocaleString()} 字${est.truncated ? '(超上限,將截斷)' : ''}`,
        `${est.dimensions} 維度 · 約 ${est.modelCalls} 次模型呼叫`,
        `估輸入約 ${k(est.estInputTokens)} tokens`,
      ];
      if (est.skipped?.length) parts.push(`跳過:${est.skipped.map((s) => s.name).join('、')}`);
      box.innerHTML = `📊 ${parts.join('　|　')}<br><span class="est-note">實際費用依模型與快取而定;開了語料快取後,維度 2 起的語料部分以快取價計。</span>`;
      box.hidden = false;
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#btn-backup').addEventListener('click', () => {
    window.location.href = '/api/backup';
    toast('開始下載備份⋯');
  });

  // 設定
  const applyProviderVisibility = (provider) => {
    $('#fields-anthropic').hidden = provider !== 'anthropic';
    $('#fields-compat').hidden = provider !== 'compat';
    $('#fields-openai').hidden = provider !== 'openai';
  };
  $('#setting-provider').addEventListener('change', (e) => applyProviderVisibility(e.target.value));
  $('#btn-settings').addEventListener('click', async () => {
    const cfg = await api('/api/config');
    $('#setting-provider').value = cfg.provider;
    applyProviderVisibility(cfg.provider);
    // Anthropic
    $('#setting-apikey').value = '';
    $('#setting-apikey').placeholder = cfg.apiKeyMasked || 'sk-ant-⋯(留空則使用環境變數/ant 登入)';
    $('#setting-model').value = cfg.model;
    $('#apikey-status').textContent = cfg.hasApiKey ? '✓ 已偵測到可用憑證' : '⚠ 尚未偵測到 API 憑證,蒸餾與對話將無法使用';
    // Anthropic 相容(MiniMax)
    $('#setting-compat-url').value = cfg.compatBaseURL || '';
    $('#setting-compat-model').value = cfg.compatModel || '';
    $('#setting-compat-key').value = '';
    $('#setting-compat-key').placeholder = cfg.compatHasKey ? '(已設定,留空保留)' : '你的 MiniMax API 金鑰';
    // OpenAI 相容
    $('#setting-openai-url').value = cfg.openaiBaseURL || '';
    $('#setting-openai-model').value = cfg.openaiModel || '';
    $('#setting-openai-key').value = '';
    $('#setting-openai-key').placeholder = cfg.openaiHasKey ? '(已設定,留空保留)' : '留空即可';
    // 強制繁體 + 變體 + 維度模型
    $('#setting-force-trad').checked = cfg.forceTraditional;
    $('#setting-zh-variant').value = cfg.zhVariant || 'twp';
    $('#setting-dim-model').value = cfg.dimensionModel || '';
    const syncVariant = () => { $('#variant-label').style.display = $('#setting-force-trad').checked ? '' : 'none'; };
    $('#setting-force-trad').onchange = syncVariant;
    syncVariant();
    $('#modal-settings').showModal();
  });
  $('#form-settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const provider = $('#setting-provider').value;
      const patch = { provider, forceTraditional: $('#setting-force-trad').checked };
      if (provider === 'anthropic') {
        patch.model = $('#setting-model').value;
        const key = $('#setting-apikey').value.trim();
        if (key) patch.apiKey = key;
      } else if (provider === 'compat') {
        patch.compatBaseURL = $('#setting-compat-url').value.trim();
        patch.compatModel = $('#setting-compat-model').value.trim();
        const ckey = $('#setting-compat-key').value.trim();
        if (ckey) patch.compatApiKey = ckey;
        if (!patch.compatModel) { toast('請填入模型名稱(例:MiniMax-M3)', true); return; }
      } else {
        patch.openaiBaseURL = $('#setting-openai-url').value.trim();
        patch.openaiModel = $('#setting-openai-model').value.trim();
        const okey = $('#setting-openai-key').value.trim();
        if (okey) patch.openaiApiKey = okey;
        if (!patch.openaiModel) { toast('請填入本地模型名稱', true); return; }
      }
      patch.zhVariant = $('#setting-zh-variant').value;
      patch.dimensionModel = $('#setting-dim-model').value.trim();
      await api('/api/config', { method: 'PUT', body: patch });
      $('#modal-settings').close();
      toast('設定已儲存');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // 儲存別名(對話對象稱呼)
  $('#btn-save-aliases').addEventListener('click', async () => {
    try {
      const updated = await api(`/api/characters/${encodeURIComponent(state.current.id)}`, {
        method: 'PATCH',
        body: { aliases: $('#char-aliases-input').value },
      });
      state.current.aliases = updated.aliases;
      $('#char-aliases-input').value = (updated.aliases || []).join(', ');
      toast(updated.aliases.length ? `已記錄稱呼:${updated.aliases.join('、')}` : '已清除稱呼');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // 人物操作
  $('#btn-delete-character').addEventListener('click', async () => {
    if (!confirm(`確定刪除「${state.current.name}」?語料、檔案與對話都會一併刪除。`)) return;
    try {
      await api(`/api/characters/${encodeURIComponent(state.current.id)}`, { method: 'DELETE' });
      closeJobStream(); // 關閉可能仍在進行的蒸餾進度串流
      state.current = null;
      await refreshCharacters();
      showView('view-empty');
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#btn-open-folder').addEventListener('click', () =>
    api(`/api/characters/${encodeURIComponent(state.current.id)}/open-folder`, { method: 'POST' })
      .catch((err) => toast(err.message, true)));
  $('#sources-path').addEventListener('click', () => {
    navigator.clipboard?.writeText(state.current.sourcesPath);
    toast('路徑已複製');
  });

  // 上傳
  $('#btn-upload').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    uploadFiles([...e.target.files]);
    e.target.value = '';
  });
  const dz = $('#dropzone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
  dz.addEventListener('drop', (e) => {
    e.preventDefault();
    dz.classList.remove('dragover');
    uploadFiles([...e.dataTransfer.files]);
  });

  // 蒸餾
  $('#btn-distill').addEventListener('click', async () => {
    const files = await api(`/api/characters/${encodeURIComponent(state.current.id)}/files`);
    if (!files.length) { toast('sources 資料夾是空的,先放入文件再蒸餾', true); return; }
    if (state.current.hasPersona && !confirm('重新蒸餾會覆蓋現有的人物檔案,確定?')) return;
    try {
      $('#estimate-box').hidden = true;
      const { jobId } = await api(`/api/characters/${encodeURIComponent(state.current.id)}/distill`, {
        method: 'POST',
        body: { gear: $('#gear-select').value },
      });
      const chip = $('#char-status');
      chip.textContent = STATUS_LABEL.distilling;
      chip.className = 'status-chip distilling';
      attachJobStream(jobId);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // 開新對話(模式選擇)
  // 關係練習:情境選單
  let SCENARIOS = [];
  const scenarioHint = () => {
    const s = SCENARIOS.find((x) => x.key === $('#new-chat-scenario').value);
    $('#scenario-hint').textContent = s ? `${STAR(s.difficulty)}　${s.goal}` : '';
  };
  const loadScenarios = async () => {
    if (SCENARIOS.length) return;
    try {
      SCENARIOS = await api('/api/training-scenarios');
      $('#new-chat-scenario').innerHTML = SCENARIOS
        .map((s) => `<option value="${s.key}">${esc(s.label)}　${STAR(s.difficulty)}</option>`).join('');
    } catch { /* 靜默:選單留空 */ }
  };
  $('#new-chat-scenario').addEventListener('change', scenarioHint);

  const modeHint = () => {
    const m = $('#new-chat-mode').value;
    const name = state.current?.name || '此人';
    $('#new-chat-hint').textContent = MODE_HINTS[m]?.(name) || '';
    const isTraining = m === 'training';
    $('#training-opts').hidden = !isTraining;
    if (isTraining) scenarioHint();
  };
  $('#new-chat-mode').addEventListener('change', modeHint);
  const openNewChat = async () => {
    if (!state.current.hasPersona) { toast('請先完成蒸餾,才能開始對話', true); return; }
    $('#form-new-chat').reset();
    await loadScenarios();
    modeHint();
    $('#modal-new-chat').showModal();
  };
  $('#btn-new-chat').addEventListener('click', openNewChat);
  $('#form-new-chat').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const mode = $('#new-chat-mode').value;
      const conditions = {
        scenario: $('#cond-scenario').value.trim(),
        timepoint: $('#cond-timepoint').value.trim(),
        interlocutor: $('#cond-interlocutor').value.trim(),
        style: $('#cond-style').value.trim(),
        extra: $('#cond-extra').value.trim(),
      };
      for (const k of Object.keys(conditions)) if (!conditions[k]) delete conditions[k];
      const payload = { title: $('#cond-title').value.trim(), mode, conditions };
      if (mode === 'training') {
        payload.scenario = $('#new-chat-scenario').value;
        payload.coachMode = $('#new-chat-coachmode').value;
      }
      const chat = await api(`/api/characters/${encodeURIComponent(state.current.id)}/chats`, {
        method: 'POST', body: payload,
      });
      $('#modal-new-chat').close();
      await openChat(chat.id);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // 對話視圖
  $('#btn-back').addEventListener('click', async () => {
    maybeAutoRemember(); // 離開對話:自動記憶(若開啟)
    showView('view-character');
    try {
      renderChats(await api(`/api/characters/${encodeURIComponent(state.current.id)}/chats`));
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#btn-remember').addEventListener('click', async () => {
    if (!state.chat || state.remembering) return;
    const btn = $('#btn-remember');
    state.remembering = true;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '記憶中⋯';
    try {
      await api(`/api/characters/${encodeURIComponent(state.current.id)}/chats/${encodeURIComponent(state.chat.id)}/remember`, { method: 'POST', body: {} });
      toast('已更新跨對話記憶——開新對話時他會記得這次');
    } catch (err) {
      toast(err.message, true);
    } finally {
      state.remembering = false;
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  $('#btn-save-prediction').addEventListener('click', async () => {
    const msgs = state.chat?.messages || [];
    const lastAsst = [...msgs].reverse().find((m) => m.role === 'assistant');
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (!lastAsst) { toast('這個對話還沒有預測可以存', true); return; }
    try {
      await api(`/api/characters/${encodeURIComponent(state.current.id)}/predictions`, {
        method: 'POST', body: { situation: lastUser?.content || '', prediction: lastAsst.content },
      });
      toast('已存為預測——事後到人物頁「預測記錄」回填實際結果');
    } catch (err) { toast(err.message, true); }
  });
  $('#btn-predictions').addEventListener('click', async () => {
    try {
      const list = await api(`/api/characters/${encodeURIComponent(state.current.id)}/predictions`);
      renderPredictions(state.current.id, list);
      $('#modal-predictions').showModal();
    } catch (err) { toast(err.message, true); }
  });
  $('#btn-review').addEventListener('click', () => runReview(false));
  $('#btn-review-regen').addEventListener('click', () => runReview(true));
  $('#btn-review-close').addEventListener('click', closeReview);
  $('#modal-review').addEventListener('close', () => { state.reviewCtrl?.abort(); state.reviewCtrl = null; });
  $('#btn-show-conditions').addEventListener('click', () => {
    const b = $('#conditions-banner');
    b.hidden = !b.hidden;
  });
  $('#btn-send').addEventListener('click', sendMessage);
  $('#composer-input').addEventListener('keydown', (e) => {
    // keyCode 229 = Safari 送出注音/中文組字的 Enter,不可誤判為送出
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 議事會
  $('#btn-new-council').addEventListener('click', () => {
    const ready = state.characters.filter((c) => c.hasPersona);
    if (ready.length < 2) { toast('至少要有 2 位已蒸餾的人物才能召集議事會', true); return; }
    const picker = $('#council-picker');
    picker.innerHTML = ready.map((c) => `
      <label class="council-pick-item">
        <input type="checkbox" value="${esc(c.id)}"><span>${esc(c.name)}</span>
      </label>`).join('');
    $('#council-title').value = '';
    $('#modal-new-council').showModal();
  });
  $('#form-new-council').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ids = [...document.querySelectorAll('#council-picker input:checked')].map((i) => i.value);
    if (ids.length < 2) { toast('請至少選 2 位人物', true); return; }
    try {
      const council = await api('/api/councils', {
        method: 'POST',
        body: { title: $('#council-title').value.trim(), participantIds: ids, moderator: $('#council-moderator').checked },
      });
      $('#modal-new-council').close();
      await refreshCouncils();
      await openCouncil(council.id);
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#btn-council-back').addEventListener('click', () => {
    state.councilCtrl?.abort();
    state.councilCtrl = null;
    state.council = null;
    showView('view-empty');
    refreshCouncils();
  });
  $('#btn-council-delete').addEventListener('click', async () => {
    if (!confirm(`刪除議事會「${state.council.title}」?`)) return;
    try {
      state.councilCtrl?.abort();
      state.councilCtrl = null;
      await api(`/api/councils/${encodeURIComponent(state.council.id)}`, { method: 'DELETE' });
      state.council = null;
      showView('view-empty');
      await refreshCouncils();
    } catch (err) {
      toast(err.message, true);
    }
  });
  $('#btn-council-send').addEventListener('click', sendCouncilMessage);
  $('#council-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendCouncilMessage();
    }
  });

  // 視窗層級:文件拖放到 dropzone 以外的地方時,阻止瀏覽器導航去開啟該檔
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // 從外部把文件放進 sources 資料夾後回到視窗:自動重新整理檔案清單
  window.addEventListener('focus', async () => {
    if (!state.current || $('#view-character').hidden) return;
    try {
      renderFiles(await api(`/api/characters/${encodeURIComponent(state.current.id)}/files`));
      refreshCharacters();
    } catch { /* 人物可能已刪除,忽略 */ }
  });

  // modal 通用關閉
  for (const btn of document.querySelectorAll('[data-close]')) {
    btn.addEventListener('click', () => btn.closest('dialog').close());
  }
}

// ---------- 啟動 ----------

(async function init() {
  bind();
  await refreshCharacters();
  await refreshCouncils();
  showView('view-empty');
  const cfg = await api('/api/config');
  if (!cfg.hasCredentials) {
    toast('尚未設定模型憑證,請先到左下角「設定」填入', true);
  }
})();
