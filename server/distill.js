import fs from 'fs';
import path from 'path';
import { loadCorpus, corpusToPrompt, extractFile, looksLikeChatExport, normalizeChatExport, corpusCharBudget } from './extract.js';
import {
  DIMENSIONS,
  QUICK_DIMENSION_KEYS,
  distillSharedSystem,
  dimensionInstruction,
  synthesisPrompt,
  qualityCriticPrompt,
  personaBuildPrompt,
  timelineUpdatePrompt,
  synthesisUpdatePrompt,
} from './prompts.js';
import { streamChat, describeError } from './llm.js';
import { toTraditional, shouldForceTraditional } from './zhtw.js';
import { getCharacter, updateCharacter, researchDir, writePersona, readConfig, sourcesDir, sourcesManifest } from './store.js';

const PLACEHOLDER_MARK = '<!--distill-failed-->';

// 從模型輸出中擷取第一個平衡的 JSON 物件(忽略前後散文、字串內的大括號)
function extractJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ---------- 簡易工作管理器（記憶體內，含事件緩衝供 SSE 重播） ----------

const jobs = new Map(); // jobId -> job

export function makeJob(characterId) {
  const job = {
    id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    characterId,
    status: 'running', // running | done | error
    events: [],
    listeners: new Set(),
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function emit(job, type, data = {}) {
  const evt = { type, time: Date.now(), ...data };
  job.events.push(evt);
  for (const fn of job.listeners) fn(evt);
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function getActiveJobForCharacter(characterId) {
  for (const job of jobs.values()) {
    if (job.characterId === characterId && job.status === 'running') return job;
  }
  return null;
}

export function cancelJobsForCharacter(characterId) {
  for (const job of jobs.values()) {
    if (job.characterId === characterId && job.status === 'running') {
      job.cancelled = true;
      job.status = 'error';
      emit(job, 'error', { message: '人物已刪除,蒸餾工作已取消。' });
    }
  }
}

export function subscribe(job, fn) {
  job.listeners.add(fn);
  return () => job.listeners.delete(fn);
}

// ---------- 蒸餾管線 ----------

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

export function startDistillation(characterId, { gear = 'standard', resume = false } = {}) {
  const existing = getActiveJobForCharacter(characterId);
  if (existing) return existing;

  const job = makeJob(characterId);
  runPipeline(job, characterId, gear, { resume }).catch((err) => {
    // runPipeline 內部已處理錯誤；這裡是最後防線
    if (job.status === 'running') {
      job.status = 'error';
      emit(job, 'error', { message: describeError(err) });
    }
  });
  return job;
}

// 單一維度重跑:只重做指定維度,再從磁碟上全部 research 檔重建綜合+persona
export function regenerateDimension(characterId, dimKey) {
  const existing = getActiveJobForCharacter(characterId);
  if (existing) return existing;
  const dim = DIMENSIONS.find((d) => d.key === dimKey);
  if (!dim) throw new Error('未知的維度');

  const job = makeJob(characterId);
  runRegenDimension(job, characterId, dim).catch((err) => {
    if (job.status === 'running') {
      job.status = 'error';
      emit(job, 'error', { message: describeError(err) });
    }
  });
  return job;
}

async function runRegenDimension(job, characterId, dim) {
  const character = getCharacter(characterId);
  const gear = character.gear || 'standard';
  updateCharacter(characterId, { status: 'distilling', lastError: null });
  const cfg = readConfig();
  const dimModel = cfg.dimensionModel || undefined;
  const lang = character.outputLanguage || 'zh-Hant';
  const trad = shouldForceTraditional(character);
  const zh = (t) => (trad ? toTraditional(t) : t);
  const checkCancelled = () => {
    if (job.cancelled) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
  };
  const rDir = researchDir(characterId);

  try {
    emit(job, 'phase', { phase: 'corpus', label: '載入語料' });
    const corpus = await loadCorpus(characterId);
    if (!corpus.docs.length) throw new Error('sources 資料夾中沒有可解析的文件。');
    const sharedSystem = distillSharedSystem(character.name, character.note, character.aliases, lang);
    const corpusBlock = `以下是「${character.name}」的本地語料:\n\n${corpusToPrompt(corpus)}`;

    // 重跑此維度
    emit(job, 'phase', { phase: 'research', label: `重跑維度：${dim.label}` });
    emit(job, 'dimension', { key: dim.key, label: dim.label, state: 'start' });
    const { text } = await streamChat({
      system: [
        { type: 'text', text: sharedSystem },
        { type: 'text', text: corpusBlock, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: dimensionInstruction(dim) }],
      maxTokens: 20000,
      model: dimModel,
    });
    checkCancelled();
    fs.writeFileSync(path.join(rDir, `${dim.key}.md`), zh(text));
    emit(job, 'dimension', { key: dim.key, label: dim.label, state: 'done', chars: text.length });

    // 從磁碟上全部維度檔重建綜合 + persona
    const gearDims = gear === 'quick'
      ? DIMENSIONS.filter((d) => QUICK_DIMENSION_KEYS.includes(d.key))
      : DIMENSIONS;
    const results = gearDims
      .map((d) => {
        const p = path.join(rDir, `${d.key}.md`);
        return fs.existsSync(p) ? { dim: d, text: fs.readFileSync(p, 'utf8') } : null;
      })
      .filter(Boolean);

    await synthesizeAndBuild({ job, characterId, character, gear, lang, zh, results, checkCancelled, rDir });
    updateCharacter(characterId, { status: 'ready', distilledAt: new Date().toISOString(), gear, corpusManifest: sourcesManifest(characterId) });
    job.status = 'done';
    emit(job, 'done', { message: `維度「${dim.label}」已重跑並更新人物檔案。` });
  } catch (err) {
    if (err.cancelled) return;
    const msg = describeError(err);
    updateCharacter(characterId, { status: 'error', lastError: msg });
    job.status = 'error';
    emit(job, 'error', { message: msg });
  }
}

async function runPipeline(job, characterId, gear, opts = {}) {
  const character = getCharacter(characterId);
  updateCharacter(characterId, { status: 'distilling', lastError: null });

  const cfg = readConfig();
  const dimModel = cfg.dimensionModel || undefined; // 維度用的便宜模型;未設則用預設(強)模型
  const lang = character.outputLanguage || 'zh-Hant';
  // 強制繁體時,所有落盤產出都過一次 OpenCC(依此人物的輸出語言決定)
  const trad = shouldForceTraditional(character);
  const zh = (t) => (trad ? toTraditional(t) : t);

  const checkCancelled = () => {
    if (job.cancelled) {
      const e = new Error('cancelled');
      e.cancelled = true;
      throw e;
    }
  };

  try {
    // Phase 0: 載入語料
    emit(job, 'phase', { phase: 'corpus', label: '載入語料' });
    const corpus = await loadCorpus(characterId);
    if (!corpus.docs.length) {
      throw new Error('sources 資料夾中沒有可解析的文件。請先放入此人的相關文件（txt/md/pdf/docx/srt/vtt）。');
    }
    emit(job, 'corpus', {
      files: corpus.docs.map((d) => ({ name: d.name, chars: d.text.length })),
      skipped: corpus.skipped,
      totalChars: corpus.totalChars,
      truncated: corpus.truncated,
    });

    const corpusText = corpusToPrompt(corpus);
    const dims =
      gear === 'quick'
        ? DIMENSIONS.filter((d) => QUICK_DIMENSION_KEYS.includes(d.key))
        : DIMENSIONS;

    // Phase 1: 多維度分析。語料放在位元組相同的共享系統前綴 + cache_control,
    // 讓維度 2..N 重用語料快取(對 anthropic / MiniMax 相容端點有效,大幅省 input 費用)
    emit(job, 'phase', { phase: 'research', label: `維度分析（${dims.length} 個維度）` });
    const rDir = researchDir(characterId);
    fs.mkdirSync(rDir, { recursive: true });
    const sharedSystem = distillSharedSystem(character.name, character.note, character.aliases, lang);
    const corpusBlock = `以下是「${character.name}」的本地語料:\n\n${corpusText}`;

    const runDim = async (dim) => {
      checkCancelled();
      const filePath = path.join(rDir, `${dim.key}.md`);
      // 續跑:若已有成功的落盤結果(非失敗佔位),重用不重跑
      if (opts.resume && fs.existsSync(filePath)) {
        const prior = fs.readFileSync(filePath, 'utf8');
        if (!prior.includes(PLACEHOLDER_MARK) && prior.trim().length > 40) {
          emit(job, 'dimension', { key: dim.key, label: dim.label, state: 'cached', chars: prior.length });
          return { dim, text: prior };
        }
      }
      emit(job, 'dimension', { key: dim.key, label: dim.label, state: 'start' });
      try {
        const { text } = await streamChat({
          system: [
            { type: 'text', text: sharedSystem },
            { type: 'text', text: corpusBlock, cache_control: { type: 'ephemeral' } },
          ],
          messages: [{ role: 'user', content: dimensionInstruction(dim) }],
          maxTokens: 20000,
          model: dimModel,
        });
        checkCancelled();
        const outText = zh(text);
        fs.writeFileSync(filePath, outText);
        emit(job, 'dimension', { key: dim.key, label: dim.label, state: 'done', chars: outText.length });
        return { dim, text: outText };
      } catch (err) {
        if (err.cancelled) throw err;
        const msg = describeError(err);
        emit(job, 'dimension', { key: dim.key, label: dim.label, state: 'failed', message: msg });
        const placeholder = `# ${dim.label}\n\n${PLACEHOLDER_MARK}\n（此維度分析失敗：${msg}）\n`;
        fs.writeFileSync(filePath, placeholder);
        return { dim, text: placeholder, failed: true };
      }
    };

    const results = await runWithConcurrency(dims.map((dim) => () => runDim(dim)), 2);
    if (results.filter((r) => !r.failed).length === 0) {
      throw new Error('所有維度分析都失敗了，管線中止。請檢查 API 設定後重試。');
    }

    // Phase 2-4: 綜合提煉 → 品質閘 → persona(可重用於單維度重跑)
    await synthesizeAndBuild({ job, characterId, character, gear, lang, zh, results, checkCancelled, rDir });

    updateCharacter(characterId, { status: 'ready', distilledAt: new Date().toISOString(), gear, corpusManifest: sourcesManifest(characterId) });
    job.status = 'done';
    emit(job, 'done', { message: '蒸餾完成，可以開始對話了。' });
  } catch (err) {
    if (err.cancelled) {
      // 人物已刪除:不可寫回 character.json(會重建目錄);cancelJobsForCharacter 已發過 error 事件
      return;
    }
    const msg = describeError(err);
    updateCharacter(characterId, { status: 'error', lastError: msg });
    job.status = 'error';
    emit(job, 'error', { message: msg });
  }
}

// ---------- 語料增量更新(關係還在進行:丟新檔 → 時間線更新 → 綜合增修 → persona 重建) ----------

// 與上次蒸餾快照比對,找出新增/變動的語料檔;無快照(舊人物)時退回 mtime > distilledAt
export function detectNewSources(character) {
  const cur = sourcesManifest(character.id);
  const manifest = character.corpusManifest || null;
  const out = [];
  for (const [name, sig] of Object.entries(cur)) {
    if (manifest) {
      if (manifest[name] !== sig) out.push(name);
    } else if (character.distilledAt) {
      const mt = Number(sig.split(':')[1]);
      if (mt > Date.parse(character.distilledAt)) out.push(name);
    }
  }
  return out;
}

export function startIncrementalUpdate(characterId) {
  const existing = getActiveJobForCharacter(characterId);
  if (existing) return existing;
  const job = makeJob(characterId);
  runIncremental(job, characterId).catch((err) => {
    if (job.status === 'running') {
      job.status = 'error';
      emit(job, 'error', { message: describeError(err) });
    }
  });
  return job;
}

async function runIncremental(job, characterId) {
  const character = getCharacter(characterId);
  updateCharacter(characterId, { status: 'distilling', lastError: null });
  const lang = character.outputLanguage || 'zh-Hant';
  const trad = shouldForceTraditional(character);
  const zh = (t) => (trad ? toTraditional(t) : t);
  const checkCancelled = () => {
    if (job.cancelled) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
  };
  const rDir = researchDir(characterId);

  try {
    const synthP = path.join(rDir, 'synthesis.md');
    if (!fs.existsSync(synthP)) throw new Error('找不到既有綜合報告——請先完成一次完整蒸餾,之後才能增量更新。');

    emit(job, 'phase', { phase: 'corpus', label: '載入新語料' });
    const newNames = detectNewSources(character);
    if (!newNames.length) throw new Error('沒有偵測到新的語料檔案。把新文件放進 sources 後再試。');
    const budget = Math.floor(corpusCharBudget() / 2); // 增量只吃新檔,預算取一半保守值
    const docs = [];
    for (const name of newNames) {
      let text;
      try { text = await extractFile(path.join(sourcesDir(characterId), name)); } catch { continue; }
      if (!text || !text.trim()) continue;
      if (looksLikeChatExport(text)) text = normalizeChatExport(text);
      docs.push({ name, text: text.trim() });
    }
    if (!docs.length) throw new Error('新檔案無法解析或內容為空。');
    let total = docs.reduce((s, d) => s + d.text.length, 0);
    const truncated = total > budget;
    if (truncated) {
      const ratio = budget / total;
      for (const d of docs) d.text = d.text.slice(0, Math.max(2000, Math.floor(d.text.length * ratio)));
      total = docs.reduce((s, d) => s + d.text.length, 0);
    }
    emit(job, 'corpus', { files: docs.map((d) => ({ name: d.name, chars: d.text.length })), skipped: [], totalChars: total, truncated });
    const newCorpusBlock = docs.map((d) => `<document filename="${d.name}">\n${d.text}\n</document>`).join('\n\n');
    const tlP = path.join(rDir, '06-timeline.md');
    const oldTimeline = fs.existsSync(tlP) ? fs.readFileSync(tlP, 'utf8') : '(尚無時間線)';
    const oldSynth = fs.readFileSync(synthP, 'utf8');
    checkCancelled();

    // 1) 時間線更新
    emit(job, 'phase', { phase: 'research', label: '時間線增量更新' });
    emit(job, 'dimension', { key: '06-timeline', label: '人物時間線', state: 'start' });
    const tl = await streamChat({
      system: [{ type: 'text', text: timelineUpdatePrompt(character.name, lang) }],
      messages: [{ role: 'user', content: `【既有時間線】\n${oldTimeline}\n\n【新加入的語料】\n${newCorpusBlock}\n\n請輸出完整的更新版時間線。` }],
      maxTokens: 16000,
    });
    checkCancelled();
    const newTimeline = zh(tl.text);
    fs.writeFileSync(tlP, newTimeline);
    emit(job, 'dimension', { key: '06-timeline', label: '人物時間線', state: 'done', chars: newTimeline.length });

    // 2) 綜合報告增修
    emit(job, 'phase', { phase: 'synthesis', label: '綜合報告增修' });
    const sy = await streamChat({
      system: [{ type: 'text', text: synthesisUpdatePrompt(character.name, lang) }],
      messages: [{ role: 'user', content: `【既有綜合報告】\n${oldSynth}\n\n【更新後的時間線】\n${newTimeline}\n\n【新加入的語料】\n${newCorpusBlock}\n\n請輸出完整的更新版綜合報告。` }],
      maxTokens: 24000,
    });
    checkCancelled();
    const synthText = zh(sy.text);
    fs.writeFileSync(synthP, synthText);
    emit(job, 'synthesis', { chars: synthText.length });

    // 3) persona 重建(writePersona 會自動快照舊版到 versions/)
    emit(job, 'phase', { phase: 'build', label: '重建人物檔案 persona.md' });
    const persona = await streamChat({
      system: personaBuildPrompt(character.name, lang),
      messages: [{ role: 'user', content: `以下是「${character.name}」的思維框架綜合報告,請組裝為 persona.md:\n\n${synthText}` }],
      maxTokens: 32000,
    });
    checkCancelled();
    let personaText = zh(persona.text.trim());
    personaText = personaText.replace(/^```(?:markdown)?\n([\s\S]*)\n```$/m, '$1').trim();
    const stamp = `\n\n---\n> 本檔案由女媧蒸餾管線生成(方法論:[nuwa-skill](https://github.com/alchaincyf/nuwa-skill))\n> 最近一次為增量更新:${new Date().toISOString().slice(0, 10)}(新增 ${docs.length} 份語料)\n`;
    writePersona(characterId, personaText + stamp);

    updateCharacter(characterId, { status: 'ready', distilledAt: new Date().toISOString(), corpusManifest: sourcesManifest(characterId) });
    job.status = 'done';
    emit(job, 'done', { message: `增量更新完成:時間線與人物檔案已依 ${docs.length} 份新語料更新。` });
  } catch (err) {
    if (err.cancelled) return;
    const msg = describeError(err);
    updateCharacter(characterId, { status: 'error', lastError: msg });
    job.status = 'error';
    emit(job, 'error', { message: msg });
  }
}

const MAX_REFINE = 2; // 品質不合格時最多重跑幾次綜合

// Phase 2 綜合 → Phase 3 品質閘(不合格則帶著批評重跑)→ Phase 4 persona 組裝
async function synthesizeAndBuild({ job, characterId, character, gear, lang, zh, results, checkCancelled, rDir }) {
  // 排除失敗的維度佔位符,避免「此維度分析失敗」被當成真材料餵進綜合/品質/persona。
  // 以 PLACEHOLDER_MARK 為準,同時涵蓋 runPipeline(有 failed 旗標)與 runRegenDimension(從磁碟重建,無旗標)兩條路徑。
  const valid = results.filter((r) => !r.failed && !r.text.includes(PLACEHOLDER_MARK) && r.text.trim().length > 40);
  if (!valid.length) throw new Error('沒有可用的維度分析結果,無法提煉。請重跑蒸餾。');
  const researchBundle = valid
    .map((r) => `<research dimension="${r.dim.label}">\n${r.text}\n</research>`)
    .join('\n\n');

  // Phase 2: 框架提煉
  emit(job, 'phase', { phase: 'synthesis', label: '框架提煉（心智模型三重驗證）' });
  let synthText = zh(
    (await streamChat({
      system: synthesisPrompt(character.name, character.note, lang),
      messages: [{ role: 'user', content: `以下是各維度的調研文件，請執行結構化提煉：\n\n${researchBundle}` }],
      maxTokens: 32000,
    })).text
  );
  checkCancelled();

  // Phase 3: 品質閘 + 不合格重跑
  for (let round = 0; round <= MAX_REFINE; round++) {
    emit(job, 'phase', { phase: 'quality', label: `品質稽核${round ? `（第 ${round + 1} 輪）` : ''}` });
    let report = null;
    try {
      const critic = await streamChat({
        system: qualityCriticPrompt(character.name),
        messages: [{ role: 'user', content: `綜合報告:\n${synthText}\n\n=== 調研原文 ===\n${researchBundle}` }],
        maxTokens: 8000,
      });
      const jsonStr = extractJson(critic.text);
      if (jsonStr) report = JSON.parse(jsonStr);
    } catch {
      report = null; // 稽核失敗不阻擋交付
    }
    checkCancelled();

    const passed = report?.pass === true || report?.pass === 'true';
    if (report) {
      fs.writeFileSync(path.join(rDir, 'quality-report.md'), '```json\n' + JSON.stringify(report, null, 2) + '\n```\n');
      emit(job, 'quality', {
        pass: passed,
        round: round + 1,
        issues: report.criticalIssues || [],
        untraceableQuotes: report.untraceableQuotes || [],
        fakeModels: report.fakeModels || [],
      });
    }

    if (!report || passed || round === MAX_REFINE) break;

    // 帶著具體批評重跑綜合
    emit(job, 'phase', { phase: 'refine', label: `依稽核回饋重新提煉（第 ${round + 2} 輪）` });
    const critique = [
      ...(report.criticalIssues || []),
      ...(report.untraceableQuotes || []).map((q) => `查無出處的引語需刪除或改寫:「${q}」`),
      ...(report.fakeModels || []).map((m) => `偽心智模型需移除或降級:${m}`),
    ].join('\n- ');
    synthText = zh(
      (await streamChat({
        system: synthesisPrompt(character.name, character.note, lang),
        messages: [{
          role: 'user',
          content: `以下是各維度的調研文件:\n\n${researchBundle}\n\n=== 這是你上一版草稿 ===\n${synthText}\n\n=== 品質稽核發現以下必須修正的問題 ===\n- ${critique}\n\n請針對上述問題修正,重新產出完整綜合報告(不要只回覆修改處)。`,
        }],
        maxTokens: 32000,
      })).text
    );
    checkCancelled();
  }

  fs.writeFileSync(path.join(rDir, 'synthesis.md'), synthText);
  emit(job, 'synthesis', { chars: synthText.length });

  // Phase 4: 人物檔案構建
  emit(job, 'phase', { phase: 'build', label: '構建人物檔案 persona.md' });
  const persona = await streamChat({
    system: personaBuildPrompt(character.name, lang),
    messages: [{ role: 'user', content: `以下是「${character.name}」的思維框架綜合報告，請組裝為 persona.md：\n\n${synthText}` }],
    maxTokens: 32000,
  });
  checkCancelled();

  let personaText = zh(persona.text.trim());
  personaText = personaText.replace(/^```(?:markdown)?\n([\s\S]*)\n```$/m, '$1').trim();
  const stamp = `\n\n---\n> 本檔案由女媧蒸餾管線生成（方法論：[nuwa-skill](https://github.com/alchaincyf/nuwa-skill)）\n> 蒸餾時間：${new Date().toISOString().slice(0, 10)}｜檔位：${gear === 'quick' ? '快速（3維度）' : '標準（6維度）'}\n`;
  writePersona(characterId, personaText + stamp);
}
