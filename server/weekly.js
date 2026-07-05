import fs from 'fs';
import path from 'path';
import { getCharacter, characterDir, listChats, getChat, readJournal, readPredictions, readMemory } from './store.js';
import { streamChat, describeError } from './llm.js';
import { weeklyReviewPrompt } from './prompts.js';
import { toTraditional, shouldForceTraditional } from './zhtw.js';

// 週回顧:把「這週的對話 + 你的日誌 + 預測驗證 + 記憶」彙整成一頁回顧(一次模型呼叫,落盤保存)

const reviewsPath = (id) => path.join(characterDir(id), 'reviews.json');

export function readReviews(characterId) {
  try { return JSON.parse(fs.readFileSync(reviewsPath(characterId), 'utf8')); } catch { return []; }
}

function gatherMaterial(characterId, days) {
  const since = Date.now() - days * 86400_000;
  const inWindow = (iso) => iso && Date.parse(iso) >= since;

  // 這段期間有更新的對話(最多 4 個,各取最後 8 則,單則截 200 字)
  const chats = [];
  for (const c of listChats(characterId)) {
    let chat;
    try { chat = getChat(characterId, c.id); } catch { continue; }
    if (!inWindow(chat.updatedAt)) continue;
    const msgs = (chat.messages || [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-8)
      .map((m) => `${m.role === 'user' ? '你' : '對方'}:${String(m.content).replace(/\s+/g, ' ').slice(0, 200)}`);
    if (msgs.length) chats.push({ title: chat.title, mode: chat.mode, msgs });
    if (chats.length >= 4) break;
  }

  const journal = readJournal()
    .filter((e) => inWindow(e.at) && (!e.characterId || e.characterId === characterId))
    .slice(0, 10);

  const predictions = readPredictions(characterId)
    .filter((r) => r.verdict || inWindow(r.at))
    .slice(0, 5);

  return { chats, journal, predictions, memory: readMemory(characterId) };
}

export async function handleWeeklyReview(req, res) {
  const { id: charId } = req.params;
  let character;
  try { character = getCharacter(charId); } catch {
    res.status(404).json({ error: '找不到人物' });
    return;
  }
  const days = Math.max(1, Math.min(31, Number(req.body?.days) || 7));
  const m = gatherMaterial(charId, days);
  if (!m.chats.length && !m.journal.length) {
    res.status(400).json({ error: `這 ${days} 天沒有對話或日誌紀錄,還沒有可回顧的素材。` });
    return;
  }

  const ctrl = new AbortController();
  let aborted = false;
  res.on('close', () => { if (!res.writableEnded) { aborted = true; ctrl.abort(); } });

  const parts = [];
  if (m.chats.length) {
    parts.push(`【這段期間的對話摘錄】\n${m.chats.map((c) => `# ${c.title}(${c.mode})\n${c.msgs.join('\n')}`).join('\n\n')}`);
  }
  if (m.journal.length) {
    parts.push(`【你的成長日誌】\n${m.journal.map((e) => `- ${e.at.slice(0, 10)}:${e.text}`).join('\n')}`);
  }
  if (m.predictions.length) {
    const V = { hit: '命中', partial: '部分', miss: '落空', '': '待驗證' };
    parts.push(`【預測與實際】\n${m.predictions.map((r) => `- [${V[r.verdict] || '待驗證'}] 情境:${(r.situation || '—').slice(0, 120)}${r.outcome ? `|實際:${r.outcome.slice(0, 120)}` : ''}`).join('\n')}`);
  }
  if (m.memory && m.memory.trim()) parts.push(`【跨對話記憶(背景)】\n${m.memory.slice(0, 1500)}`);

  try {
    const r = await streamChat({
      system: [{ type: 'text', text: weeklyReviewPrompt(character.name) }],
      messages: [{ role: 'user', content: `回顧範圍:過去 ${days} 天。素材如下:\n\n${parts.join('\n\n')}` }],
      maxTokens: 1500,
      signal: ctrl.signal,
    });
    if (aborted) return;
    const content = (shouldForceTraditional(character) ? toTraditional(r.text) : r.text).trim();
    const reviews = readReviews(charId);
    reviews.unshift({ id: `r-${Date.now()}`, at: new Date().toISOString(), days, content });
    fs.writeFileSync(reviewsPath(charId), JSON.stringify(reviews.slice(0, 30), null, 2));
    res.json({ content });
  } catch (err) {
    if (!aborted) res.status(500).json({ error: describeError(err) });
  }
}
