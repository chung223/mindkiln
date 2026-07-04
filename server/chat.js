import { chatSystemBlocks } from './prompts.js';
import { streamChat, describeError } from './llm.js';
import { getCharacter, getChat, writeChat, readPersona } from './store.js';
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

  const system = chatSystemBlocks(character.name, persona, chat.conditions, chat.mode);
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

    // 重新讀取磁碟上的最新對話再追加,避免與同一對話的並發請求互相覆蓋
    // (getChat/writeChat 皆同步,單一 Node 程序內此段不會被打斷)
    const assistantMsg = { role: 'assistant', content, at: new Date().toISOString() };
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
