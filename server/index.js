import './env.js'; // 必須最先執行:載入 .env,讓下方 store.js 讀得到 NUWA_DATA_DIR
import express from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import {
  readConfig, writeConfig,
  createCharacter, getCharacter, updateCharacter, listCharacters, deleteCharacter,
  listSourceFiles, deleteSourceFile, sourcesDir,
  readPersona, writePersona, listResearch, readResearch,
  listPersonaVersions, readPersonaVersion,
  readMemory, writeMemory,
  readPredictions, writePredictions,
  readJournal, writeJournal,
  listChats, createChat, getChat, deleteChat,
  listCouncils, createCouncil, getCouncil, deleteCouncil,
} from './store.js';
import { handleCouncilMessage } from './council.js';
import { startDistillation, regenerateDimension, startIncrementalUpdate, detectNewSources, getJob, getActiveJobForCharacter, subscribe, cancelJobsForCharacter } from './distill.js';
import { handleMessage, handleSessionReview, handleMemoryUpdate, handleABPreview, handleABCommit, handleJournalSuggest } from './chat.js';
import { handleImport } from './import.js';
import { computeAnalytics, computeEmotionalArc } from './analytics.js';
import { DEFAULT_MODEL, DEFAULT_OPENAI_BASE_URL, DEFAULT_COMPAT_BASE_URL, DEFAULT_COMPAT_MODEL } from './llm.js';
import { normalizeAliases, SUBJECT_TYPES, OUTPUT_LANGUAGES } from './store.js';
import { detectSpeakersForCharacter, estimateDistillation } from './extract.js';
import { DIMENSIONS, TRAINING_SCENARIOS } from './prompts.js';
import { ZH_VARIANTS, DEFAULT_VARIANT } from './zhtw.js';
import { createBackup } from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5723;
const app = express();
app.use(express.json({ limit: '5mb' }));

// 同源防護：本機服務無驗證機制,阻擋其他網頁對本服務發出的跨站狀態變更請求。
// 以請求本身的 Host 標頭比對來源,不寫死 localhost——這樣容器 / 區網 / 自訂埠部署也能通過。
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const reqHost = req.get('host'); // 例:127.0.0.1:5723 或 192.168.1.20:5723
  const origin = req.get('origin');
  const referer = req.get('referer');
  let srcHost = null;
  if (origin) { try { srcHost = new URL(origin).host; } catch { srcHost = null; } }
  if (!srcHost && referer) { try { srcHost = new URL(referer).host; } catch { srcHost = null; } }
  if (!reqHost || !srcHost || srcHost !== reqHost) {
    res.status(403).json({ error: '跨站請求已被阻擋' });
    return;
  }
  next();
});

// 密碼驗證(選用):設 NUWA_PASSWORD 環境變數即啟用。對外(通道/區網)部署時務必開啟。
// 驗證方式:HMAC(密碼) 作為 HttpOnly cookie;未設密碼時(本機預設)完全不啟用。
const AUTH_PASSWORD = process.env.NUWA_PASSWORD || '';
const AUTH_TOKEN = AUTH_PASSWORD
  ? crypto.createHmac('sha256', AUTH_PASSWORD).update('nuwa-session-v1').digest('hex')
  : null;
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next();
  // 用小寫比對:Express 路由預設不分大小寫,守衛必須跟路由一致,否則 /API/... 可繞過驗證
  const p = req.path.toLowerCase();
  if (!p.startsWith('/api/') || p === '/api/login') return next();
  const cookie = (req.get('cookie') || '')
    .split(';').map((s) => s.trim())
    .find((s) => s.startsWith('nuwa_auth='));
  const val = cookie ? cookie.slice('nuwa_auth='.length) : '';
  if (val && safeEqual(val, AUTH_TOKEN)) return next();
  res.status(401).json({ error: '需要登入' });
});

app.post('/api/login', (req, res) => {
  if (!AUTH_TOKEN) { res.json({ ok: true, noauth: true }); return; }
  const { password } = req.body || {};
  if (typeof password !== 'string' || !safeEqual(password, AUTH_PASSWORD)) {
    res.status(401).json({ error: '密碼錯誤' });
    return;
  }
  res.setHeader('Set-Cookie', `nuwa_auth=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err.code === 'ENOENT') {
      if (!res.headersSent) res.status(404).json({ error: '找不到資源' });
      return;
    }
    if (err.status) {
      // 帶狀態碼的使用者條件錯誤(如「沒有可分析的內容」):不是伺服器故障,不進 error log
      if (!res.headersSent) res.status(err.status).json({ error: err.message });
      return;
    }
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
};

// ---------- 設定 ----------

app.get('/api/config', (req, res) => {
  const cfg = readConfig();
  const provider = ['openai', 'compat'].includes(cfg.provider) ? cfg.provider : 'anthropic';
  const anthropicReady = Boolean(cfg.apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  let hasCredentials;
  if (provider === 'openai') hasCredentials = Boolean(cfg.openaiBaseURL || DEFAULT_OPENAI_BASE_URL);
  else if (provider === 'compat') hasCredentials = Boolean(cfg.compatApiKey);
  else hasCredentials = anthropicReady;
  res.json({
    provider,
    hasCredentials,
    hasApiKey: anthropicReady,
    apiKeyMasked: cfg.apiKey ? `${cfg.apiKey.slice(0, 10)}…${cfg.apiKey.slice(-4)}` : null,
    model: cfg.model || DEFAULT_MODEL,
    defaultModel: DEFAULT_MODEL,
    openaiBaseURL: cfg.openaiBaseURL || DEFAULT_OPENAI_BASE_URL,
    openaiModel: cfg.openaiModel || '',
    openaiHasKey: Boolean(cfg.openaiApiKey),
    compatBaseURL: cfg.compatBaseURL || DEFAULT_COMPAT_BASE_URL,
    compatModel: cfg.compatModel || DEFAULT_COMPAT_MODEL,
    compatHasKey: Boolean(cfg.compatApiKey),
    corpusBudget: cfg.corpusBudget || null,
    forceTraditional: cfg.forceTraditional !== false, // 預設開啟
    zhVariant: cfg.zhVariant || DEFAULT_VARIANT,
    dimensionModel: cfg.dimensionModel || '', // 維度用的便宜模型(留空=與主模型相同)
  });
});

app.put('/api/config', (req, res) => {
  const {
    apiKey, model, provider, openaiBaseURL, openaiModel, openaiApiKey,
    compatBaseURL, compatModel, compatApiKey, corpusBudget, forceTraditional,
    zhVariant, dimensionModel,
  } = req.body || {};
  const patch = {};
  if (provider !== undefined) patch.provider = ['openai', 'compat'].includes(provider) ? provider : 'anthropic';
  if (apiKey !== undefined) patch.apiKey = apiKey;
  if (model !== undefined) patch.model = model;
  if (openaiBaseURL !== undefined) patch.openaiBaseURL = openaiBaseURL;
  if (openaiModel !== undefined) patch.openaiModel = openaiModel;
  if (openaiApiKey !== undefined) patch.openaiApiKey = openaiApiKey;
  if (compatBaseURL !== undefined) patch.compatBaseURL = compatBaseURL;
  if (compatModel !== undefined) patch.compatModel = compatModel;
  if (compatApiKey !== undefined) patch.compatApiKey = compatApiKey;
  if (corpusBudget !== undefined) patch.corpusBudget = corpusBudget ? Number(corpusBudget) : null;
  if (forceTraditional !== undefined) patch.forceTraditional = Boolean(forceTraditional);
  if (zhVariant !== undefined) patch.zhVariant = ZH_VARIANTS.includes(zhVariant) ? zhVariant : DEFAULT_VARIANT;
  if (dimensionModel !== undefined) patch.dimensionModel = dimensionModel;
  writeConfig(patch);
  res.json({ ok: true });
});

// 一鍵備份:把整個 data/ 打包下載
app.get('/api/backup', (req, res) => createBackup(res));

// ---------- 人物 ----------

app.get('/api/characters', (req, res) => {
  res.json(listCharacters());
});

app.post('/api/characters', wrap((req, res) => {
  const meta = createCharacter(req.body || {});
  res.json({ ...meta, sourcesPath: sourcesDir(meta.id) });
}));

// 匯入現成的 nuwa-skill 人物(GitHub 網址 或 貼上 persona),免蒸餾
app.post('/api/import', wrap(handleImport));

app.get('/api/characters/:id', wrap((req, res) => {
  const meta = getCharacter(req.params.id);
  res.json({
    ...meta,
    sourcesPath: sourcesDir(meta.id),
    files: listSourceFiles(meta.id),
    hasPersona: Boolean(readPersona(meta.id)),
    research: listResearch(meta.id),
    activeJobId: getActiveJobForCharacter(meta.id)?.id || null,
    pendingSources: meta.status === 'ready' ? detectNewSources(meta) : [], // 蒸餾後新增/變動的語料檔
  });
}));

app.patch('/api/characters/:id', wrap((req, res) => {
  const { name, note, aliases, subjectType, consentAck, outputLanguage } = req.body || {};
  const patch = {};
  if (name !== undefined) patch.name = String(name).trim();
  if (note !== undefined) patch.note = String(note).trim();
  if (aliases !== undefined) patch.aliases = normalizeAliases(aliases);
  if (subjectType !== undefined && SUBJECT_TYPES.includes(subjectType)) patch.subjectType = subjectType;
  if (consentAck !== undefined) patch.consentAck = Boolean(consentAck);
  if (outputLanguage !== undefined && OUTPUT_LANGUAGES.includes(outputLanguage)) patch.outputLanguage = outputLanguage;
  if (req.body?.autoMemory !== undefined) patch.autoMemory = Boolean(req.body.autoMemory);
  res.json(updateCharacter(req.params.id, patch));
}));

// 自動偵測語料中的發言者(供勾選為別名)
app.get('/api/characters/:id/speakers', wrap(async (req, res) => {
  getCharacter(req.params.id);
  res.json(await detectSpeakersForCharacter(req.params.id));
}));

app.delete('/api/characters/:id', wrap((req, res) => {
  cancelJobsForCharacter(req.params.id); // 取消進行中的蒸餾,避免殭屍工作重建目錄
  deleteCharacter(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/characters/:id/open-folder', wrap((req, res) => {
  getCharacter(req.params.id); // 驗證存在(不存在則丟 ENOENT → 404)
  const dir = sourcesDir(req.params.id);
  // execFile 以參數陣列傳遞,dir 不經 shell 解析,shell 元字元一律失效
  execFile('open', [dir]);
  res.json({ ok: true, path: dir });
}));

// ---------- 語料文件 ----------

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, sourcesDir(req.params.id)),
    filename: (req, file, cb) => {
      // multer 以 latin1 解析檔名，中文檔名需轉回 utf8
      const fixed = Buffer.from(file.originalname, 'latin1').toString('utf8');
      cb(null, path.basename(fixed));
    },
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

app.get('/api/characters/:id/files', wrap((req, res) => {
  res.json(listSourceFiles(req.params.id));
}));

app.post('/api/characters/:id/files', upload.array('files', 50), wrap((req, res) => {
  res.json(listSourceFiles(req.params.id));
}));

app.delete('/api/characters/:id/files/:name', wrap((req, res) => {
  deleteSourceFile(req.params.id, req.params.name);
  res.json(listSourceFiles(req.params.id));
}));

// ---------- 蒸餾 ----------

// 蒸餾前乾跑估算(不呼叫模型)
app.get('/api/characters/:id/estimate', wrap(async (req, res) => {
  getCharacter(req.params.id);
  const gear = req.query.gear === 'quick' ? 'quick' : 'standard';
  res.json(await estimateDistillation(req.params.id, gear));
}));

app.post('/api/characters/:id/distill', wrap((req, res) => {
  const { gear, resume } = req.body || {};
  getCharacter(req.params.id); // 驗證存在
  const job = startDistillation(req.params.id, {
    gear: gear === 'quick' ? 'quick' : 'standard',
    resume: Boolean(resume),
  });
  res.json({ jobId: job.id });
}));

// 單一維度重跑(不必整條重來)
app.post('/api/characters/:id/regenerate-dimension', wrap((req, res) => {
  const { dimension } = req.body || {};
  getCharacter(req.params.id);
  if (!DIMENSIONS.some((d) => d.key === dimension)) {
    res.status(400).json({ error: '未知的維度' });
    return;
  }
  const job = regenerateDimension(req.params.id, dimension);
  res.json({ jobId: job.id });
}));

app.get('/api/jobs/:jobId/stream', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: '找不到此工作' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (evt) => res.write(`data: ${JSON.stringify(evt)}\n\n`);
  // 重播歷史事件（斷線重連 / 晚加入也能看到完整進度）
  for (const evt of job.events) send(evt);
  if (job.status !== 'running') {
    res.end();
    return;
  }
  const unsubscribe = subscribe(job, (evt) => {
    send(evt);
    if (evt.type === 'done' || evt.type === 'error') res.end();
  });
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// ---------- 人物檔案與調研文件 ----------

app.get('/api/characters/:id/persona', wrap((req, res) => {
  const persona = readPersona(req.params.id);
  if (!persona) {
    res.status(404).json({ error: '尚未蒸餾' });
    return;
  }
  res.json({ persona });
}));

app.put('/api/characters/:id/persona', wrap((req, res) => {
  const { persona } = req.body || {};
  if (!persona || !persona.trim()) {
    res.status(400).json({ error: '內容不可為空' });
    return;
  }
  writePersona(req.params.id, persona);
  res.json({ ok: true });
}));

// persona 版本歷史:每次覆寫前自動快照,可檢視 / 回溯
app.get('/api/characters/:id/persona-versions', wrap((req, res) => {
  getCharacter(req.params.id);
  res.json(listPersonaVersions(req.params.id));
}));

app.get('/api/characters/:id/persona-versions/:name', wrap((req, res) => {
  const content = readPersonaVersion(req.params.id, req.params.name);
  if (content == null) {
    res.status(404).json({ error: '找不到此版本' });
    return;
  }
  res.json({ content });
}));

app.post('/api/characters/:id/persona-versions/:name/restore', wrap((req, res) => {
  const content = readPersonaVersion(req.params.id, req.params.name);
  if (content == null) {
    res.status(404).json({ error: '找不到此版本' });
    return;
  }
  writePersona(req.params.id, content); // 回溯本身也會先快照現況,可再還原
  res.json({ ok: true });
}));

// 跨對話記憶:檢視 / 手動編輯或清空 / 從某段對話更新
app.get('/api/characters/:id/memory', wrap((req, res) => {
  getCharacter(req.params.id); // 驗證存在
  res.json({ memory: readMemory(req.params.id) });
}));

app.put('/api/characters/:id/memory', wrap((req, res) => {
  getCharacter(req.params.id);
  writeMemory(req.params.id, (req.body && req.body.memory) || ''); // 允許清空
  res.json({ ok: true });
}));

app.post('/api/characters/:id/chats/:chatId/remember', wrap(handleMemoryUpdate));

// A/B 排練:同一脈絡兩種說法並行預覽(不落盤)→ 採用其一才落盤
app.post('/api/characters/:id/chats/:chatId/ab', wrap(handleABPreview));
app.post('/api/characters/:id/chats/:chatId/ab-commit', wrap(handleABCommit));

// 關係儀表板:純計算統計(零模型成本)+ 情感弧線(一次呼叫,落盤快取)
app.get('/api/characters/:id/analytics', wrap(async (req, res) => {
  res.json(await computeAnalytics(req.params.id));
}));
app.post('/api/characters/:id/analytics/arc', wrap(async (req, res) => {
  res.json(await computeEmotionalArc(req.params.id));
}));

// 語料增量更新(關係還在進行:丟新檔 → 時間線/綜合/persona 跟著演進)
app.post('/api/characters/:id/distill-incremental', wrap((req, res) => {
  const meta = getCharacter(req.params.id);
  // 先在路由層擋掉「沒有新檔」,避免白開一個工作、把人物狀態打成 error
  if (!detectNewSources(meta).length) {
    res.status(400).json({ error: '沒有偵測到新的語料檔案。把新文件放進 sources 後再試。' });
    return;
  }
  const job = startIncrementalUpdate(req.params.id);
  res.json({ jobId: job.id });
}));

// 對話全文搜尋
app.get('/api/characters/:id/chat-search', wrap((req, res) => {
  const id = req.params.id;
  getCharacter(id);
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) { res.json([]); return; }
  const out = [];
  for (const c of listChats(id)) {
    let chat;
    try { chat = getChat(id, c.id); } catch { continue; }
    let snippet = null;
    if ((chat.title || '').toLowerCase().includes(q)) snippet = chat.title;
    else {
      for (const m of chat.messages || []) {
        const t = String(m.content || '');
        const i = t.toLowerCase().indexOf(q);
        if (i >= 0) {
          const s = Math.max(0, i - 30);
          snippet = (s > 0 ? '…' : '') + t.slice(s, i + q.length + 40).replace(/\n/g, ' ') + '…';
          break;
        }
      }
    }
    if (snippet) {
      out.push({ chatId: chat.id, title: chat.title, mode: chat.mode, snippet });
      if (out.length >= 30) break;
    }
  }
  res.json(out);
}));

// 成長日誌(全域:記錄使用者自己的變化)
app.get('/api/journal', (req, res) => {
  res.json(readJournal());
});
app.post('/api/journal', wrap((req, res) => {
  const { text, characterId, characterName, mode } = req.body || {};
  if (!text || !text.trim()) { res.status(400).json({ error: '內容不可為空' }); return; }
  const arr = readJournal();
  const rec = {
    id: `j-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    text: String(text).trim().slice(0, 2000),
    characterId: String(characterId || '').slice(0, 200),
    characterName: String(characterName || '').slice(0, 200),
    mode: String(mode || '').slice(0, 50),
  };
  arr.unshift(rec);
  writeJournal(arr);
  res.json(rec);
}));
app.delete('/api/journal/:jid', wrap((req, res) => {
  writeJournal(readJournal().filter((r) => r.id !== req.params.jid));
  res.json({ ok: true });
}));
app.post('/api/characters/:id/chats/:chatId/journal-suggest', wrap(handleJournalSuggest));

// 可驗證預測:存下預測 → 事後回填實際結果 → 累積此人物的準度
app.get('/api/characters/:id/predictions', wrap((req, res) => {
  getCharacter(req.params.id);
  res.json(readPredictions(req.params.id));
}));

app.post('/api/characters/:id/predictions', wrap((req, res) => {
  getCharacter(req.params.id);
  const { situation, prediction } = req.body || {};
  if (!prediction || !prediction.trim()) {
    res.status(400).json({ error: '預測內容不可為空' });
    return;
  }
  const arr = readPredictions(req.params.id);
  const rec = {
    id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    situation: (situation || '').trim().slice(0, 2000),
    prediction: prediction.trim().slice(0, 4000),
    outcome: '',
    verdict: '', // '' | hit | miss | partial
  };
  arr.unshift(rec);
  writePredictions(req.params.id, arr);
  res.json(rec);
}));

app.patch('/api/characters/:id/predictions/:pid', wrap((req, res) => {
  getCharacter(req.params.id);
  const arr = readPredictions(req.params.id);
  const rec = arr.find((r) => r.id === req.params.pid);
  if (!rec) {
    res.status(404).json({ error: '找不到此預測' });
    return;
  }
  const { outcome, verdict } = req.body || {};
  if (outcome !== undefined) rec.outcome = String(outcome).slice(0, 2000);
  if (verdict !== undefined && ['', 'hit', 'miss', 'partial'].includes(verdict)) rec.verdict = verdict;
  writePredictions(req.params.id, arr);
  res.json(rec);
}));

app.delete('/api/characters/:id/predictions/:pid', wrap((req, res) => {
  getCharacter(req.params.id);
  writePredictions(req.params.id, readPredictions(req.params.id).filter((r) => r.id !== req.params.pid));
  res.json({ ok: true });
}));

app.get('/api/characters/:id/research/:file', wrap((req, res) => {
  const content = readResearch(req.params.id, req.params.file);
  if (content === null) {
    res.status(404).json({ error: '找不到文件' });
    return;
  }
  res.json({ content });
}));

// ---------- 對話 ----------

app.get('/api/characters/:id/chats', wrap((req, res) => {
  res.json(listChats(req.params.id));
}));

app.post('/api/characters/:id/chats', wrap((req, res) => {
  res.json(createChat(req.params.id, req.body || {}));
}));

app.get('/api/characters/:id/chats/:chatId', wrap((req, res) => {
  res.json(getChat(req.params.id, req.params.chatId));
}));

app.delete('/api/characters/:id/chats/:chatId', wrap((req, res) => {
  deleteChat(req.params.id, req.params.chatId);
  res.json({ ok: true });
}));

app.post('/api/characters/:id/chats/:chatId/messages', wrap(handleMessage));

// 關係練習:情境清單 + 整場檢討
app.get('/api/training-scenarios', (req, res) => {
  res.json(
    Object.entries(TRAINING_SCENARIOS).map(([key, s]) => ({
      key, label: s.label, difficulty: s.difficulty, goal: s.goal,
    }))
  );
});

app.post('/api/characters/:id/chats/:chatId/review', wrap(handleSessionReview));

// ---------- 議事會 Advisory Board ----------

app.get('/api/councils', (req, res) => {
  res.json(listCouncils());
});

app.post('/api/councils', wrap((req, res) => {
  const { title, participantIds } = req.body || {};
  const uniqueIds = Array.isArray(participantIds) ? [...new Set(participantIds)] : [];
  if (uniqueIds.length < 2) {
    res.status(400).json({ error: '議事會至少需要 2 位已蒸餾的人物' });
    return;
  }
  const participants = [];
  for (const id of uniqueIds) {
    const c = getCharacter(id); // 不存在則 ENOENT → 404
    if (!readPersona(id)) {
      res.status(400).json({ error: `「${c.name}」尚未完成蒸餾,無法加入議事會` });
      return;
    }
    participants.push({ id: c.id, name: c.name });
  }
  res.json(createCouncil({ title, participants, moderator: req.body?.moderator !== false }));
}));

app.get('/api/councils/:id', wrap((req, res) => {
  res.json(getCouncil(req.params.id));
}));

app.delete('/api/councils/:id', wrap((req, res) => {
  deleteCouncil(req.params.id);
  res.json({ ok: true });
}));

app.post('/api/councils/:id/messages', wrap(handleCouncilMessage));

// ---------- 啟動 ----------

// 啟動清理:上次程序若在蒸餾中被中斷,character.json 會殘留 distilling 狀態
// (工作只存在記憶體),此處重置為 error 讓使用者可重新蒸餾
for (const c of listCharacters()) {
  if (c.status === 'distilling') {
    updateCharacter(c.id, { status: 'error', lastError: '伺服器在蒸餾過程中重新啟動,請重新開始蒸餾。' });
  }
}

// 預設只綁 127.0.0.1(本機安全);容器/需對外時設 HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, HOST, () => {
  console.log(`女媧工坊 running at http://localhost:${PORT}`);
});
