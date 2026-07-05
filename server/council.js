import { chatSystemBlocks, councilModeratorPrompt } from './prompts.js';
import { streamChat, describeError } from './llm.js';
import { getCharacter, getCouncil, writeCouncil, readPersona } from './store.js';
import { toTraditional, shouldForceTraditional, makeStreamConverter } from './zhtw.js';

function councilPreamble(name, otherNames) {
  return `【多人議事】你正在與其他顧問一起討論同一個問題。在場的還有:${otherNames.join('、')}。
- 以你自己(${name})的身份、視角與表達DNA發言,不要模仿別人的語氣。
- 你可以回應、補充、或明確不同意其他人剛剛說的。
- 簡潔切題,一次講一個重點,別長篇獨白——這是討論。
- 訊息中標記為「[某某]:」的是其他顧問說的,不是使用者說的。`;
}

// 把議事會的完整對話,對「某位 persona」攤平成 Anthropic messages
// (自己的發言 → assistant;使用者與其他 persona → user,附具名前綴)
function messagesFor(persona, transcript) {
  const out = [];
  for (const m of transcript) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.personaId === persona.id) {
      out.push({ role: 'assistant', content: m.content });
    } else {
      out.push({ role: 'user', content: `[${m.personaName}]:\n${m.content}` });
    }
  }
  return out;
}

/**
 * 一則使用者訊息 → 每位與會 persona 依序回應(後發言者看得到先發言者,可辯論)。
 * SSE 事件:persona_start / delta / persona_done / done / error
 */
export async function handleCouncilMessage(req, res) {
  const { id: councilId } = req.params;
  const { content } = req.body || {};
  if (!content || !content.trim()) {
    res.status(400).json({ error: '訊息內容不可為空' });
    return;
  }

  let council;
  try {
    council = getCouncil(councilId);
  } catch {
    res.status(404).json({ error: '找不到議事會' });
    return;
  }

  // 載入每位在場人物的檔案(略過已刪除或未蒸餾者)
  const members = [];
  for (const p of council.participants) {
    try {
      const character = getCharacter(p.id);
      const persona = readPersona(p.id);
      if (persona) members.push({ id: p.id, name: character.name, character, persona });
    } catch {
      // 人物已刪除,跳過
    }
  }
  if (!members.length) {
    res.status(400).json({ error: '議事會中沒有可用的人物(可能都已刪除或尚未蒸餾)' });
    return;
  }

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

  // 本回合的工作副本(依序加入每位 persona 的回應,讓後者看得到前者)
  const transcript = [...council.messages, { role: 'user', content: content.trim() }];
  const produced = [];

  try {
    for (const member of members) {
      if (aborted) break;
      send('persona_start', { personaId: member.id, name: member.name });

      const otherNames = members.filter((m) => m.id !== member.id).map((m) => m.name);
      const system = chatSystemBlocks(member.name, member.persona, {}, 'chat');
      system.push({ type: 'text', text: councilPreamble(member.name, otherNames) });

      const forceTrad = shouldForceTraditional(member.character);
      const conv = forceTrad
        ? makeStreamConverter((chunk) => { if (!aborted && chunk) send('delta', { personaId: member.id, text: chunk }); })
        : null;

      try {
        const result = await streamChat({
          system,
          messages: messagesFor(member, transcript),
          maxTokens: 8000,
          signal: ctrl.signal,
          onDelta: (d) => {
            if (aborted) return;
            if (conv) conv.push(d);
            else send('delta', { personaId: member.id, text: d });
          },
        });
        if (conv) conv.flush();
        if (aborted) break;

        const reply = forceTrad ? toTraditional(result.text) : result.text;
        if (reply.trim()) {
          const msg = {
            role: 'persona', personaId: member.id, personaName: member.name,
            content: reply, at: new Date().toISOString(),
          };
          transcript.push(msg);
          produced.push(msg);
          send('persona_done', { personaId: member.id });
        } else {
          send('persona_done', { personaId: member.id, empty: true });
        }
      } catch (err) {
        if (!aborted) send('persona_error', { personaId: member.id, message: describeError(err) });
      }
    }

    // 主持人總結:全員發言後,中立收斂共識/分歧/盲點(可於建立議事會時關閉)
    if (!aborted && council.moderator !== false && produced.length >= 2) {
      send('persona_start', { personaId: '__moderator', name: '主持人' });
      const modTrad = members.some((m) => shouldForceTraditional(m.character));
      const modConv = modTrad
        ? makeStreamConverter((chunk) => { if (!aborted && chunk) send('delta', { personaId: '__moderator', text: chunk }); })
        : null;
      try {
        const result = await streamChat({
          system: [{ type: 'text', text: councilModeratorPrompt() }],
          messages: [{
            role: 'user',
            content: `使用者的問題:${content.trim()}\n\n本輪發言:\n\n${produced.map((p) => `[${p.personaName}]:\n${p.content}`).join('\n\n')}`,
          }],
          maxTokens: 2000,
          signal: ctrl.signal,
          onDelta: (d) => {
            if (aborted) return;
            if (modConv) modConv.push(d);
            else send('delta', { personaId: '__moderator', text: d });
          },
        });
        if (modConv) modConv.flush();
        if (!aborted) {
          const summary = modTrad ? toTraditional(result.text) : result.text;
          if (summary.trim()) {
            const msg = {
              role: 'moderator', personaId: '__moderator', personaName: '主持人',
              content: summary, at: new Date().toISOString(),
            };
            transcript.push(msg);
            produced.push(msg);
            send('persona_done', { personaId: '__moderator' });
          }
        }
      } catch (err) {
        if (!aborted) send('persona_error', { personaId: '__moderator', message: describeError(err) });
      }
    }

    // 只有至少一位 persona 有實際回應才寫檔(否則等於整輪失敗,不污染紀錄)。
    // 即使客戶端已中途離線(aborted),已完成的回應仍要落盤——否則使用者回來時整輪憑空消失。
    if (produced.length) {
      const latest = getCouncil(councilId); // 重讀避免並發覆蓋
      latest.messages.push({ role: 'user', content: content.trim(), at: new Date().toISOString() }, ...produced);
      writeCouncil(latest);
    }
    if (aborted) return;
    send('done', { count: produced.length });
  } catch (err) {
    if (!aborted) send('error', { message: describeError(err) });
  }
  if (!aborted) res.end();
}
