import { chatSystemBlocks, coachPrompt, getScenario, sessionReviewPrompt, memoryUpdatePrompt, journalSuggestPrompt } from './prompts.js';
import { streamChat, describeError } from './llm.js';
import { getCharacter, getChat, writeChat, readPersona, readMemory, writeMemory } from './store.js';
import { toTraditional, shouldForceTraditional, makeStreamConverter } from './zhtw.js';

/**
 * 處理一則使用者訊息：追加到對話、串流模型回應（SSE 直寫 res）、存檔。
 */
export async function handleMessage(req, res) {
  const { id: charId, chatId } = req.params;
  const { content } = req.body || {};
  if (!content || !content.trim()) {
    res.status(400).json({ error: '訊息內容不可為空' });
    return;
  }

  let character, chat, persona;
  try {
    character = getCharacter(charId);
    chat = getChat(charId, chatId);
    persona = readPersona(charId);
  } catch {
    res.status(404).json({ error: '找不到人物或對話' });
    return;
  }
  if (!persona) {
    res.status(400).json({ error: '此人物尚未完成蒸餾，無法對話。' });
    return;
  }

  const userMsg = { role: 'user', content: content.trim(), at: new Date().toISOString() };
  chat.messages.push(userMsg);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const memory = readMemory(charId); // 跨對話累積記憶(空字串則不注入)
  const system = chatSystemBlocks(character.name, persona, chat.conditions, chat.mode, chat.scenario, memory);
  const apiMessages = chat.messages.map((m) => ({ role: m.role, content: m.content }));
  // 在最後一則訊息掛快取斷點,讓後續每輪重用整段對話前綴(省 input 費用)
  const lastMsg = apiMessages[apiMessages.length - 1];
  lastMsg.content = [{ type: 'text', text: lastMsg.content, cache_control: { type: 'ephemeral' } }];

  const ctrl = new AbortController();
  let aborted = false;
  // 用 res 而非 req 偵測斷線:req 的 'close' 在 express.json 讀完 body 後就會觸發
  // (那不是客戶端斷線)。res 的 'close' 只在回應真正結束或客戶端中途離開時觸發。
  res.on('close', () => {
    if (!res.writableEnded) {
      aborted = true;
      ctrl.abort();
    }
  });

  // 強制繁體時,串流以邊界緩衝逐段轉換後送出(保持順暢且不切斷台灣詞彙)
  const forceTrad = shouldForceTraditional(character);
  const streamConv = forceTrad
    ? makeStreamConverter((chunk) => { if (!aborted && chunk) send('delta', { text: chunk }); })
    : null;

  try {
    const result = await streamChat({
      system,
      messages: apiMessages,
      maxTokens: 16000,
      signal: ctrl.signal,
      onDelta: (delta) => {
        if (aborted) return;
        if (streamConv) streamConv.push(delta);
        else send('delta', { text: delta });
      },
    });
    if (streamConv) streamConv.flush();
    if (aborted) return; // 用戶已離開:不寫檔、不送事件

    const reply = forceTrad ? toTraditional(result.text) : result.text;
    if (!reply.trim()) {
      // 例如思考階段就耗盡 max_tokens,沒有文字區塊:不持久化這輪,走錯誤回滾
      throw new Error('模型沒有產生任何回覆內容(可能因輸出達到長度上限),這輪訊息未保存,請重試或換個問法。');
    }
    const content = result.truncated ? reply + '\n\n…（輸出達到長度上限而截斷）' : reply;
    const assistantMsg = { role: 'assistant', content, at: new Date().toISOString() };

    // 訓練模式即時教練:人物回覆後,針對使用者剛剛的表達給一句點評(best-effort,失敗不影響主回覆)
    if (!aborted && chat.mode === 'training' && chat.coachMode === 'realtime') {
      const recent = chat.messages
        .slice(-7)
        .map((m) => `${m.role === 'user' ? '使用者' : character.name}：${m.content}`)
        .join('\n');
      const transcript = `${recent}\n${character.name}：${content}`;
      const coach = await runCoach({ character, scenario: chat.scenario, transcript, signal: ctrl.signal, forceTrad });
      if (coach && !aborted) {
        assistantMsg.coach = coach;
        send('coach', { text: coach });
      }
    }
    // 教練呼叫可能耗時數秒,期間客戶端可能離開:與 line 80 同樣的契約,離開就不寫檔、不送 done
    // (否則前端已回滾這輪,磁碟卻留著,重開對話會憑空多出一則)
    if (aborted) return;

    // 重新讀取磁碟上的最新對話再追加,避免與同一對話的並發請求互相覆蓋
    // (getChat/writeChat 皆同步,單一 Node 程序內此段不會被打斷)
    let latest;
    try {
      latest = getChat(charId, chatId);
    } catch {
      latest = chat; // 對話已被刪除:退回記憶體版本(寫檔會失敗但不影響回應)
    }
    latest.messages.push(userMsg, assistantMsg);
    try {
      writeChat(charId, latest);
    } catch {
      /* 對話已刪除,略過持久化 */
    }

    send('done', { usage: result.usage, stopReason: result.stopReason });
  } catch (err) {
    // 失敗時不保留這輪 user 訊息（未寫檔即等於回滾），前端可重試
    if (!aborted) send('error', { message: describeError(err) });
  }
  if (!aborted) res.end();
}

/**
 * 訓練檢討:對整段練習對話產出一份帶分數的檢討報告(SSE 串流)。
 */
export async function handleSessionReview(req, res) {
  const { id: charId, chatId } = req.params;
  let character, chat;
  try {
    character = getCharacter(charId);
    chat = getChat(charId, chatId);
  } catch {
    res.status(404).json({ error: '找不到人物或對話' });
    return;
  }
  const convo = (chat.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant');
  if (convo.length < 2) {
    res.status(400).json({ error: '對話還太短,多練幾句再結束吧。' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const sc = getScenario(chat.scenario);
  const transcript = convo
    .map((m) => `${m.role === 'user' ? '使用者' : character.name}：${m.content}`)
    .join('\n');
  const system = [{ type: 'text', text: sessionReviewPrompt(character.name, sc) }];

  const ctrl = new AbortController();
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) { aborted = true; ctrl.abort(); } });

  const forceTrad = shouldForceTraditional(character);
  const streamConv = forceTrad
    ? makeStreamConverter((chunk) => { if (!aborted && chunk) send('delta', { text: chunk }); })
    : null;

  try {
    const result = await streamChat({
      system,
      messages: [{ role: 'user', content: `這是一場「${sc.label}」練習的完整對話,請只針對「使用者」的表現產出檢討報告:\n\n${transcript}` }],
      maxTokens: 8000,
      signal: ctrl.signal,
      onDelta: (d) => { if (aborted) return; if (streamConv) streamConv.push(d); else send('delta', { text: d }); },
    });
    if (streamConv) streamConv.flush();
    if (aborted) return;
    const report = forceTrad ? toTraditional(result.text) : result.text;
    // 落盤,重開對話仍能看到上次的檢討
    try {
      const latest = getChat(charId, chatId);
      latest.review = { at: new Date().toISOString(), content: report };
      writeChat(charId, latest);
    } catch { /* 對話已刪除,略過 */ }
    send('done', {});
  } catch (err) {
    if (!aborted) send('error', { message: describeError(err) });
  }
  if (!aborted) res.end();
}

/**
 * 更新跨對話記憶:把這段對話裡值得長期記住的事,合併進此人物的 memory.md。
 */
export async function handleMemoryUpdate(req, res) {
  const { id: charId, chatId } = req.params;
  let character, chat;
  try {
    character = getCharacter(charId);
    chat = getChat(charId, chatId);
  } catch {
    res.status(404).json({ error: '找不到人物或對話' });
    return;
  }
  const convo = (chat.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant');
  if (convo.length < 2) {
    res.status(400).json({ error: '對話還太短,還沒什麼好記的' });
    return;
  }
  const existing = readMemory(charId);
  const transcript = convo
    .map((m) => `${m.role === 'user' ? '使用者' : character.name}：${m.content}`)
    .join('\n');
  // 客戶端中途離開就中止,別把整個 LLM 呼叫跑完(與 handleMessage / handleSessionReview 同契約)
  const ctrl = new AbortController();
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) { aborted = true; ctrl.abort(); } });
  try {
    const r = await streamChat({
      system: [{ type: 'text', text: memoryUpdatePrompt(character.name) }],
      messages: [{
        role: 'user',
        content: `【目前的既有記憶】\n${existing || '(目前沒有記憶)'}\n\n【新的對話】\n${transcript}\n\n請輸出更新後的完整記憶。`,
      }],
      maxTokens: 2000,
      signal: ctrl.signal,
    });
    if (aborted) return;
    const updated = (shouldForceTraditional(character) ? toTraditional(r.text) : r.text).trim();
    writeMemory(charId, updated);
    res.json({ ok: true, memory: updated });
  } catch (err) {
    if (!aborted) res.status(500).json({ error: describeError(err) });
  }
}

/**
 * A/B 排練預覽:同一段對話脈絡,兩種說法並行生成(SSE,變體標記 v:'a'|'b'),不落盤。
 */
export async function handleABPreview(req, res) {
  const { id: charId, chatId } = req.params;
  const { a, b } = req.body || {};
  if (!a || !a.trim() || !b || !b.trim()) {
    res.status(400).json({ error: '兩種說法都要填' });
    return;
  }
  let character, chat, persona;
  try {
    character = getCharacter(charId);
    chat = getChat(charId, chatId);
    persona = readPersona(charId);
  } catch {
    res.status(404).json({ error: '找不到人物或對話' });
    return;
  }
  if (!persona) { res.status(400).json({ error: '此人物尚未完成蒸餾' }); return; }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ctrl = new AbortController();
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) { aborted = true; ctrl.abort(); } });

  const memory = readMemory(charId);
  const system = chatSystemBlocks(character.name, persona, chat.conditions, chat.mode, chat.scenario, memory);
  const base = chat.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));
  // 兩個變體共用「系統 + 既有歷史」前綴:在最後一則歷史掛快取斷點,第二個變體讀快取
  if (base.length) {
    const last = base[base.length - 1];
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
  }
  const forceTrad = shouldForceTraditional(character);

  const runVariant = async (v, content) => {
    const conv = forceTrad
      ? makeStreamConverter((chunk) => { if (!aborted && chunk) send('delta', { v, text: chunk }); })
      : null;
    try {
      const result = await streamChat({
        system,
        messages: [...base, { role: 'user', content }],
        maxTokens: 8000,
        signal: ctrl.signal,
        onDelta: (d) => {
          if (aborted) return;
          if (conv) conv.push(d);
          else send('delta', { v, text: d });
        },
      });
      if (conv) conv.flush();
      if (aborted) return;
      const reply = forceTrad ? toTraditional(result.text) : result.text;
      send('variant_done', { v, text: reply });
    } catch (err) {
      if (!aborted) send('variant_error', { v, message: describeError(err) });
    }
  };

  await Promise.all([runVariant('a', a.trim()), runVariant('b', b.trim())]);
  if (aborted) return;
  send('done', {});
  res.end();
}

/**
 * A/B 採用:把選定的說法與預覽時的回覆一起落盤(不重新生成,保留使用者看到的那個回應)。
 */
export function handleABCommit(req, res) {
  const { id: charId, chatId } = req.params;
  const { content, reply } = req.body || {};
  if (!content || !content.trim() || !reply || !reply.trim()) {
    res.status(400).json({ error: '缺少說法或回覆內容' });
    return;
  }
  let chat;
  try {
    getCharacter(charId);
    chat = getChat(charId, chatId);
  } catch {
    res.status(404).json({ error: '找不到人物或對話' });
    return;
  }
  const at = new Date().toISOString();
  chat.messages.push(
    { role: 'user', content: content.trim(), at },
    { role: 'assistant', content: reply.trim(), at, ab: true }
  );
  writeChat(charId, chat);
  res.json({ ok: true });
}

/**
 * 成長日誌建議:以使用者第一人稱,濃縮這段對話的收穫成 1–2 句。
 */
export async function handleJournalSuggest(req, res) {
  const { id: charId, chatId } = req.params;
  let character, chat;
  try {
    character = getCharacter(charId);
    chat = getChat(charId, chatId);
  } catch {
    res.status(404).json({ error: '找不到人物或對話' });
    return;
  }
  const convo = (chat.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant');
  if (convo.length < 2) { res.status(400).json({ error: '對話還太短' }); return; }
  const ctrl = new AbortController();
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) { aborted = true; ctrl.abort(); } });
  const transcript = convo.slice(-30)
    .map((m) => `${m.role === 'user' ? '使用者' : character.name}：${m.content}`)
    .join('\n');
  try {
    const r = await streamChat({
      system: [{ type: 'text', text: journalSuggestPrompt(character.name) }],
      messages: [{ role: 'user', content: transcript }],
      maxTokens: 300,
      signal: ctrl.signal,
    });
    if (aborted) return;
    const text = (shouldForceTraditional(character) ? toTraditional(r.text) : r.text).trim();
    res.json({ suggestion: text });
  } catch (err) {
    if (!aborted) res.status(500).json({ error: describeError(err) });
  }
}

// 即時教練:對「使用者」剛剛的一則發言給一句點評。失敗回空字串,不影響主回覆。
async function runCoach({ character, scenario, transcript, signal, forceTrad }) {
  const sc = getScenario(scenario);
  try {
    const r = await streamChat({
      system: [{ type: 'text', text: coachPrompt(character.name, sc) }],
      messages: [{
        role: 'user',
        content: `這一場練習情境:「${sc.label}」。以下是最近的對話,「使用者」是你要點評的對象:\n\n${transcript}\n\n請針對「使用者」最後一則發言,給一句即時教練點評。`,
      }],
      maxTokens: 500,
      signal,
    });
    const text = forceTrad ? toTraditional(r.text) : r.text;
    return text.trim();
  } catch {
    return '';
  }
}
