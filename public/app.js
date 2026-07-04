/* ============ 女媧工坊 前端 ============ */

const $ = (sel) => document.querySelector(sel);

const state = {
  characters: [],
  current: null,      // 當前人物詳情
  chat: null,         // 當前對話
  jobSource: null,    // 蒸餾 SSE
  sending: false,
};

const STATUS_LABEL = { new: '待煉', distilling: '煉製中', ready: '已成', error: '失敗' };
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
      <span class="mode-chip ${ch.mode === 'predict' ? 'predict' : ''}">${ch.mode === 'predict' ? '預測' : '對話'}</span>
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

async function openChat(chatId) {
  const chat = await api(`/api/characters/${encodeURIComponent(state.current.id)}/chats/${encodeURIComponent(chatId)}`);
  state.chat = chat;
  $('#chat-char-name').textContent = state.current.name;
  const chip = $('#chat-mode-chip');
  chip.textContent = chat.mode === 'predict' ? '預測模式' : '對話模式';
  chip.className = 'mode-chip' + (chat.mode === 'predict' ? ' predict' : '');
  renderConditionsBanner(chat.conditions);
  const box = $('#messages');
  box.innerHTML = '';
  for (const m of chat.messages) appendMessage(m.role, m.content);
  showView('view-chat');
  $('#composer-input').focus();
  box.scrollTop = box.scrollHeight;
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

function appendMessage(role, content, streaming = false) {
  const box = $('#messages');
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;
  const roleName = role === 'user' ? '你' : state.current.name;
  div.innerHTML = `
    <div class="msg-role">${esc(roleName)}</div>
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
      chat.messages.push({ role: 'assistant', content: acc });
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

// ---------- 事件繫結 ----------

function bind() {
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

  // 新對話 / 新預測
  let newChatMode = 'chat';
  const openNewChat = (mode) => {
    if (!state.current.hasPersona) { toast('請先完成蒸餾,才能開始對話', true); return; }
    newChatMode = mode;
    $('#form-new-chat').reset();
    $('#new-chat-title').textContent = mode === 'predict' ? '新預測' : '新對話';
    $('#new-chat-hint').textContent =
      mode === 'predict'
        ? '描述一個情境,預測此人會如何反應或決策(附推理依據與信心度)。'
        : `以「${state.current.name}」的身份進行角色扮演對話。`;
    $('#modal-new-chat').showModal();
  };
  $('#btn-new-chat').addEventListener('click', () => openNewChat('chat'));
  $('#btn-new-predict').addEventListener('click', () => openNewChat('predict'));
  $('#form-new-chat').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const conditions = {
        scenario: $('#cond-scenario').value.trim(),
        timepoint: $('#cond-timepoint').value.trim(),
        interlocutor: $('#cond-interlocutor').value.trim(),
        style: $('#cond-style').value.trim(),
        extra: $('#cond-extra').value.trim(),
      };
      for (const k of Object.keys(conditions)) if (!conditions[k]) delete conditions[k];
      const chat = await api(`/api/characters/${encodeURIComponent(state.current.id)}/chats`, {
        method: 'POST',
        body: { title: $('#cond-title').value.trim(), mode: newChatMode, conditions },
      });
      $('#modal-new-chat').close();
      await openChat(chat.id);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // 對話視圖
  $('#btn-back').addEventListener('click', async () => {
    showView('view-character');
    try {
      renderChats(await api(`/api/characters/${encodeURIComponent(state.current.id)}/chats`));
    } catch (err) {
      toast(err.message, true);
    }
  });
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
  showView('view-empty');
  const cfg = await api('/api/config');
  if (!cfg.hasCredentials) {
    toast('尚未設定模型憑證,請先到左下角「設定」填入', true);
  }
})();
