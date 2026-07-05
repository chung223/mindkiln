import fs from 'fs';
import path from 'path';
import { makeJob, emit, getActiveJobForCharacter } from './distill.js';
import { streamChat, describeError } from './llm.js';
import { toTraditional, shouldForceTraditional } from './zhtw.js';
import {
  getCharacter, characterDir, researchDir, listResearch, readResearch,
  readPersona, writePersona, readPredictions,
} from './store.js';
import {
  chatSystemBlocks, probeGenPrompt, personaScorecardPrompt, personaEvolvePrompt,
} from './prompts.js';

// persona 演化(達爾文迴圈):評分 → 只改最弱維度 → 複評 → 分數有進步才保留,否則回滾。
// 三個角色(出題者/評分者/改寫者)各用獨立提示詞,防「自己改自己評」的分數通膨。

const DIM_LABELS = {
  quoteFidelity: '引語可溯源',
  exclusivity: '排他性',
  tension: '內在張力',
  expressionDNA: '表達DNA可執行度',
  honesty: '誠實邊界',
  probeFidelity: '探針表現',
};
const RATCHET_THRESHOLD = 1; // 總分至少要進步這麼多才保留(棘輪)

const probesPath = (id) => path.join(researchDir(id), 'probes.json');
const scorecardPath = (id) => path.join(researchDir(id), 'scorecard.json');
const evolutionPath = (id) => path.join(characterDir(id), 'evolution.json');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function extractJsonBlock(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) return text.slice(start, i + 1); }
  }
  return null;
}

async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

function researchBundle(characterId) {
  return listResearch(characterId)
    .map((f) => `<research file="${f}">\n${readResearch(characterId, f) || ''}\n</research>`)
    .join('\n\n');
}

function missedPredictionsBlock(characterId) {
  const missed = readPredictions(characterId)
    .filter((r) => (r.verdict === 'miss' || r.verdict === 'partial') && r.outcome)
    .slice(0, 5);
  if (!missed.length) return '';
  return `\n\n【預測落空紀錄(真實世界的校正證據:模型在這些情境判斷偏了)】\n${missed
    .map((r) => `- 情境:${r.situation || '—'}\n  當時預測:${r.prediction.slice(0, 300)}\n  實際結果(${r.verdict === 'miss' ? '落空' : '部分'}):${r.outcome}`)
    .join('\n')}`;
}

// 用「運行中的 persona」逐題回答探針(行為測試,不是讀文件)
async function runProbes(character, personaText, probes, checkCancelled) {
  const answers = await runWithConcurrency(
    probes.map((p) => async () => {
      try {
        const r = await streamChat({
          system: chatSystemBlocks(character.name, personaText, {}, 'chat'),
          messages: [{ role: 'user', content: p.q }],
          maxTokens: 800,
        });
        return r.text.trim();
      } catch (err) {
        return `(回答失敗:${describeError(err)})`;
      }
    }),
    3
  );
  checkCancelled();
  return probes.map((p, i) => ({ ...p, answer: answers[i] }));
}

async function scorePersona(character, personaText, probeRuns, bundle, missedBlock) {
  const transcript = probeRuns
    .map((p, i) => `## 探針 ${i + 1}\n問:${p.q}\n檢查要點:${p.expect}\npersona 的回答:\n${p.answer}`)
    .join('\n\n');
  const r = await streamChat({
    system: [{ type: 'text', text: personaScorecardPrompt(character.name) }],
    messages: [{
      role: 'user',
      content: `【persona 檔案】\n${personaText}\n\n【調研檔案】\n${bundle}\n\n【探針測試逐字稿】\n${transcript}${missedBlock}\n\n請嚴格評分,只輸出 JSON。`,
    }],
    maxTokens: 3000,
  });
  const json = extractJsonBlock(r.text);
  if (!json) throw new Error('評分者未回傳可解析的評分結果,請重試。');
  let parsed;
  try { parsed = JSON.parse(json); } catch { throw new Error('評分者未回傳可解析的評分結果,請重試。'); }
  const scores = {};
  for (const k of Object.keys(DIM_LABELS)) {
    const v = Number(parsed.scores?.[k]);
    scores[k] = Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 0;
  }
  const total = Math.round(Object.values(scores).reduce((s, v) => s + v, 0) / Object.keys(scores).length);
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0][0];
  const criticisms = (Array.isArray(parsed.criticisms) ? parsed.criticisms : []).slice(0, 6).map(String);
  return { scores, total, weakest, criticisms };
}

export function startEvolution(characterId, mode = 'evolve') {
  const existing = getActiveJobForCharacter(characterId);
  if (existing) return existing;
  const job = makeJob(characterId);
  runEvolution(job, characterId, mode).catch((err) => {
    if (job.status === 'running') {
      job.status = 'error';
      emit(job, 'error', { message: describeError(err) });
    }
  });
  return job;
}

async function runEvolution(job, characterId, mode) {
  const character = getCharacter(characterId);
  const trad = shouldForceTraditional(character);
  const zh = (t) => (trad ? toTraditional(t) : t);
  const lang = character.outputLanguage || 'zh-Hant';
  const checkCancelled = () => {
    if (job.cancelled) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
  };

  try {
    const persona = readPersona(characterId);
    if (!persona) throw Object.assign(new Error('尚未蒸餾,沒有 persona 可以評分或演化。'), { status: 400 });
    const bundle = researchBundle(characterId);
    if (!bundle.trim()) throw Object.assign(new Error('找不到調研檔案——評分需要對照調研證據。'), { status: 400 });
    const missedBlock = missedPredictionsBlock(characterId);

    // 1) 探針(快取:沒有才生成)
    emit(job, 'phase', { phase: 'corpus', label: '準備探針測試' });
    let probes = readJson(probesPath(characterId), null)?.probes;
    if (!Array.isArray(probes) || !probes.length) {
      const r = await streamChat({
        system: [{ type: 'text', text: probeGenPrompt(character.name) }],
        messages: [{ role: 'user', content: `【調研檔案】\n${bundle}\n\n請出 5 題探針,只輸出 JSON。` }],
        maxTokens: 2000,
      });
      const json = extractJsonBlock(r.text);
      let parsed = null;
      try { parsed = json ? JSON.parse(json) : null; } catch { parsed = null; }
      probes = (Array.isArray(parsed?.probes) ? parsed.probes : [])
        .filter((p) => p?.q && p?.expect)
        .slice(0, 5)
        .map((p) => ({ q: zh(String(p.q)), expect: zh(String(p.expect)) }));
      if (probes.length < 3) throw new Error('探針生成失敗,請重試。');
      fs.writeFileSync(probesPath(characterId), JSON.stringify({ generatedAt: new Date().toISOString(), probes }, null, 2));
    }
    checkCancelled();

    // 2) 跑探針 + 評分(演化前基準)
    emit(job, 'phase', { phase: 'research', label: `探針測試(${probes.length} 題)` });
    const beforeRuns = await runProbes(character, persona, probes, checkCancelled);
    emit(job, 'phase', { phase: 'quality', label: '獨立評分' });
    const before = await scorePersona(character, persona, beforeRuns, bundle, missedBlock);
    checkCancelled();
    fs.writeFileSync(scorecardPath(characterId), JSON.stringify({ at: new Date().toISOString(), ...before }, null, 2));
    emit(job, 'scorecard', { stage: 'before', ...before });

    if (mode === 'score') {
      job.status = 'done';
      emit(job, 'done', { message: `體檢完成:總分 ${before.total}/100,最弱維度「${DIM_LABELS[before.weakest]}」(${before.scores[before.weakest]} 分)。` });
      return;
    }

    // 3) 單維度定向改寫
    const dimLabel = DIM_LABELS[before.weakest];
    emit(job, 'phase', { phase: 'synthesis', label: `演化改寫:${dimLabel}` });
    const rewrite = await streamChat({
      system: [{ type: 'text', text: personaEvolvePrompt(character.name, dimLabel, lang) }],
      messages: [{
        role: 'user',
        content: `【目前的 persona】\n${persona}\n\n【調研檔案(引語唯一合法來源)】\n${bundle}\n\n【評分者對「${dimLabel}」的具體批評】\n- ${before.criticisms.join('\n- ')}${missedBlock}\n\n請輸出完整改良版 persona。`,
      }],
      maxTokens: 32000,
    });
    checkCancelled();
    let candidate = zh(rewrite.text.trim()).replace(/^```(?:markdown)?\n([\s\S]*)\n```$/m, '$1').trim();
    if (candidate.length < 500) throw new Error('改寫結果異常(過短),本輪捨棄。');

    // 4) 複評(同一套探針 + 同一位評分者)→ 棘輪裁決
    emit(job, 'phase', { phase: 'research', label: '複測探針' });
    const afterRuns = await runProbes(character, candidate, probes, checkCancelled);
    emit(job, 'phase', { phase: 'quality', label: '複評與棘輪裁決' });
    const after = await scorePersona(character, candidate, afterRuns, bundle, missedBlock);
    checkCancelled();

    const kept = after.total >= before.total + RATCHET_THRESHOLD;
    if (kept) {
      // writePersona 會自動把舊版快照進 versions/,隨時可回溯
      const stamp = `\n\n---\n> 演化紀錄:${new Date().toISOString().slice(0, 10)} 針對「${dimLabel}」定向改良(${before.total} → ${after.total} 分,棘輪保留)\n`;
      writePersona(characterId, candidate + stamp);
      fs.writeFileSync(scorecardPath(characterId), JSON.stringify({ at: new Date().toISOString(), ...after }, null, 2));
    }
    emit(job, 'scorecard', { stage: 'after', kept, ...after });

    const log = readJson(evolutionPath(characterId), []);
    log.unshift({
      at: new Date().toISOString(),
      dimension: before.weakest,
      dimensionLabel: dimLabel,
      before: { total: before.total, scores: before.scores },
      after: { total: after.total, scores: after.scores },
      kept,
    });
    fs.writeFileSync(evolutionPath(characterId), JSON.stringify(log.slice(0, 50), null, 2));

    job.status = 'done';
    emit(job, 'done', {
      message: kept
        ? `演化保留:「${dimLabel}」定向改良,總分 ${before.total} → ${after.total}。舊版已存入版本歷史。`
        : `演化回滾:改寫後總分 ${before.total} → ${after.total},未達棘輪門檻(+${RATCHET_THRESHOLD}),persona 保持原樣——這正是棘輪的用途。`,
    });
  } catch (err) {
    if (err.cancelled) return;
    job.status = 'error';
    emit(job, 'error', { message: describeError(err) });
  }
}

export function readEvolutionState(characterId) {
  return {
    scorecard: readJson(scorecardPath(characterId), null),
    probes: readJson(probesPath(characterId), null)?.probes?.length || 0,
    rounds: readJson(evolutionPath(characterId), []),
    dimLabels: DIM_LABELS,
  };
}
