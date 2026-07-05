import path from 'path';
import { getCharacter, listSourceFiles, sourcesDir, sourcesManifest, readPersona } from './store.js';
import { extractFile, parseChatEvents, looksLikeChatExport } from './extract.js';
import { normalizeForMatch } from './quotes.js';
import { chatSystemBlocks, dialogueSimPrompt } from './prompts.js';
import { streamChat, describeError } from './llm.js';
import { toTraditional, shouldForceTraditional, makeStreamConverter } from './zhtw.js';

// 趣味包:「她會怎麼接?」猜謎、今日一籤、雙 persona 對話模擬(含時間切點=時光機)

// ---------- 語料事件快取(語料沒變就不重新解析) ----------

const cache = new Map(); // characterId -> { sig, events }

function subjectMatcher(character) {
  const keys = [character.name, ...(character.aliases || [])]
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => s.length >= 2);
  return (sp) => {
    const s = String(sp).trim().toLowerCase();
    return keys.some((k) => s === k || s.includes(k) || k.includes(s));
  };
}

async function loadEvents(characterId) {
  const sig = JSON.stringify(sourcesManifest(characterId));
  const hit = cache.get(characterId);
  if (hit && hit.sig === sig) return hit.events;
  const events = [];
  for (const f of listSourceFiles(characterId)) {
    let text;
    try { text = await extractFile(path.join(sourcesDir(characterId), f.name)); } catch { continue; }
    if (!text || !looksLikeChatExport(text)) continue;
    events.push(...parseChatEvents(text).filter((e) => e.speaker));
    events.push({ fileBoundary: true }); // 檔案交界:不可跨檔組成對話
  }
  cache.set(characterId, { sig, events });
  return events;
}

// ---------- 猜謎:從真實對話抽「對方說了幾句 → 她怎麼接」 ----------

// 純函式(可測試):從事件流抽出合格的交換對
export function extractExchanges(events, isSubject) {
  const out = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.fileBoundary || e.media || !e.text) continue;
    if (!isSubject(e.speaker)) continue;
    if (normalizeForMatch(e.text).length < 10) continue; // 她的回覆要有內容
    // 往回收集脈絡:最多 5 則,且緊鄰的上一則必須是對方說的(才算「接話」)
    const ctx = [];
    for (let j = i - 1; j >= 0 && ctx.length < 5; j--) {
      const p = events[j];
      if (p.fileBoundary) break;
      if (p.media || !p.text) continue;
      ctx.unshift({ speaker: p.speaker, text: p.text.slice(0, 200), self: isSubject(p.speaker) });
    }
    if (!ctx.length || ctx[ctx.length - 1].self) continue; // 上一句必須是對方
    if (!ctx.some((c) => !c.self)) continue;
    out.push({ context: ctx, answer: { text: e.text.slice(0, 400), date: e.date } });
  }
  return out;
}

// 確定性亂數(避免依賴 Math.random 也方便「每日一籤」以日期為種子)
export function seededIndex(seedStr, len) {
  let h = 2166136261;
  for (const ch of String(seedStr)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % Math.max(1, len);
}

export async function handleGuessItem(req, res) {
  const character = getCharacter(req.params.id);
  const events = await loadEvents(req.params.id);
  const pool = extractExchanges(events, subjectMatcher(character));
  if (pool.length < 5) {
    res.status(400).json({ error: '語料中找不到足夠的對話交換(需要聊天匯出格式)。' });
    return;
  }
  const seed = req.query.seed || `${Date.now()}-${pool.length}`;
  const item = pool[seededIndex(seed, pool.length)];
  res.json({ total: pool.length, name: character.name, ...item });
}

// persona 也來答同一題(一次呼叫)
export async function handleGuessPersona(req, res) {
  const character = getCharacter(req.params.id);
  const persona = readPersona(req.params.id);
  if (!persona) { res.status(400).json({ error: '尚未蒸餾' }); return; }
  const context = Array.isArray(req.body?.context) ? req.body.context.slice(-6) : [];
  if (!context.length) { res.status(400).json({ error: '缺少對話脈絡' }); return; }
  const ctrl = new AbortController();
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) { aborted = true; ctrl.abort(); } });
  // 把脈絡攤成訊息:她的話→assistant,對方→user
  const messages = [];
  for (const c of context) {
    const role = c.self ? 'assistant' : 'user';
    const text = String(c.text || '').slice(0, 300);
    if (messages.length && messages[messages.length - 1].role === role) {
      messages[messages.length - 1].content += `\n${text}`;
    } else {
      messages.push({ role, content: text });
    }
  }
  try {
    const r = await streamChat({
      system: chatSystemBlocks(character.name, persona, {}, 'chat'),
      messages,
      maxTokens: 600,
      signal: ctrl.signal,
    });
    if (aborted) return;
    const text = (shouldForceTraditional(character) ? toTraditional(r.text) : r.text).trim();
    res.json({ reply: text });
  } catch (err) {
    if (!aborted) res.status(500).json({ error: describeError(err) });
  }
}

// ---------- 今日一籤:以日期為種子,從她的真實發言確定性抽一句 ----------

export async function handleDailyQuote(req, res) {
  const character = getCharacter(req.params.id);
  const events = await loadEvents(req.params.id);
  const isSubject = subjectMatcher(character);
  const pool = events.filter((e) => !e.fileBoundary && !e.media && e.text && isSubject(e.speaker)
    && normalizeForMatch(e.text).length >= 12 && e.date);
  if (!pool.length) { res.status(400).json({ error: '語料中沒有可抽的發言。' }); return; }
  const today = new Date().toISOString().slice(0, 10);
  const pick = pool[seededIndex(`${today}|${req.params.id}`, pool.length)];
  res.json({ today, quote: { text: pick.text.replace(/\s+/g, ' ').slice(0, 200), date: pick.date } });
}

// ---------- 對話模擬:兩個 persona 自動對談(同一人 + 不同時間切點 = 時光機) ----------

export async function handleSimulate(req, res) {
  const { aId, bId, opening, turns, aTime, bTime } = req.body || {};
  if (!opening || !opening.trim()) { res.status(400).json({ error: '要給一句開場白' }); return; }
  const nTurns = Math.max(2, Math.min(10, Number(turns) || 6));
  let A, B;
  try {
    A = { id: aId, character: getCharacter(aId), persona: readPersona(aId), time: String(aTime || '').trim() };
    B = { id: bId, character: getCharacter(bId), persona: readPersona(bId), time: String(bTime || '').trim() };
  } catch {
    res.status(404).json({ error: '找不到人物' });
    return;
  }
  if (!A.persona || !B.persona) { res.status(400).json({ error: '兩位人物都要已完成蒸餾' }); return; }

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

  // 同一人分身時,顯示名加上時間標籤
  const label = (S) => S.character.name + (A.id === B.id && S.time ? `(${S.time})` : '');
  const transcript = [{ side: 'a', text: opening.trim() }];
  send('sim_msg', { side: 'a', name: label(A), text: opening.trim(), opening: true });

  try {
    for (let t = 0; t < nTurns && !aborted; t++) {
      const S = t % 2 === 0 ? B : A; // 開場是 A,先由 B 回
      const other = S === A ? B : A;
      const side = S === A ? 'a' : 'b';
      send('sim_start', { side, name: label(S) });
      const system = chatSystemBlocks(S.character.name, S.persona, {}, 'chat');
      system.push({ type: 'text', text: dialogueSimPrompt(label(S), label(other), S.time) });
      const messages = transcript.map((m) => ({
        role: (m.side === 'a') === (S === A) ? 'assistant' : 'user',
        content: m.text,
      }));
      const trad = shouldForceTraditional(S.character);
      const conv = trad
        ? makeStreamConverter((chunk) => { if (!aborted && chunk) send('delta', { side, text: chunk }); })
        : null;
      const r = await streamChat({
        system,
        messages,
        maxTokens: 1200,
        signal: ctrl.signal,
        onDelta: (d) => {
          if (aborted) return;
          if (conv) conv.push(d);
          else send('delta', { side, text: d });
        },
      });
      if (conv) conv.flush();
      if (aborted) break;
      const text = (trad ? toTraditional(r.text) : r.text).trim();
      if (!text) break;
      transcript.push({ side, text });
      send('sim_done', { side });
    }
    if (!aborted) send('done', { turns: transcript.length - 1 });
  } catch (err) {
    if (!aborted) send('error', { message: describeError(err) });
  }
  if (!aborted) res.end();
}
