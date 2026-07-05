import path from 'path';
import { getCharacter, listSourceFiles, sourcesDir, readPersona, listResearch, readResearch } from './store.js';
import { loadCorpus, corpusToPrompt, extractFile, parseChatEvents, looksLikeChatExport } from './extract.js';

// 引語驗證器:persona / 調研檔裡的每句「引語」,確定性回查原始語料。
// 純文字比對——零模型成本、秒級、不會說謊。這是對抗蒸餾管線捏造引語的地基。

// 比對前剝除的字元(標點/空白/格式符):兩邊同樣正規化,只比實質文字
const STRIP_CHARS = new Set('，。！？、～~（）()「」『』《》〈〉:：;；.!?,-—–…⋯*_>#`"\'|·・'.split(''));
const isStrip = (ch) => STRIP_CHARS.has(ch) || /\s/.test(ch);

export function normalizeForMatch(s) {
  let out = '';
  for (const ch of String(s)) if (!isStrip(ch)) out += ch;
  return out;
}

// 建正規化索引:norm 字串 + 每個 norm 位置對應回原文位置(供回溯日期錨點/來源檔)
export function buildCorpusIndex(raw) {
  let norm = '';
  const map = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (isStrip(ch)) continue;
    norm += ch;
    map.push(i);
  }
  return { raw, norm, map };
}

// 從 markdown 抽出所有「」引語(去重,長度合理者)
export function extractQuotes(mdText) {
  const seen = new Set();
  const out = [];
  for (const m of String(mdText).matchAll(/「([^」\n]{2,200})」/g)) {
    const q = m[1].trim();
    if (!seen.has(q)) { seen.add(q); out.push(q); }
  }
  return out;
}

function locate(index, normPos) {
  const rawPos = index.map[normPos] ?? 0;
  const before = index.raw.slice(0, rawPos);
  const anchor = before.match(/—— (\d{4}\/\d{1,2}\/\d{1,2}) ——(?![\s\S]*—— \d{4}\/\d{1,2}\/\d{1,2} ——)/);
  const doc = before.match(/<document filename="([^"]+)">(?![\s\S]*<document filename=")/);
  return { date: anchor ? anchor[1] : null, sourceFile: doc ? doc[1] : null };
}

// 驗證單一引語:整句可溯源 → verified;含分隔符的複合引語,每段都找得到也算 verified(composite)
function checkQuote(index, quote) {
  const nq = normalizeForMatch(quote);
  if (nq.length < 5) return { quote, status: 'skipped' }; // 太短(如單詞),比對無意義
  const at = index.norm.indexOf(nq);
  if (at >= 0) return { quote, status: 'verified', ...locate(index, at) };
  // 複合引語:「a／b」「a;b」逐段驗。所有段都須命中(合取,誤判風險低),
  // 故單段門檻放寬到 3 字,但整組至少要有一段 ≥5 字才有鑑別度。
  const rawSegs = quote.split(/[／/;；\n]/).map((s) => s.trim()).filter(Boolean);
  if (rawSegs.length > 1) {
    const segNorms = rawSegs.map((s) => normalizeForMatch(s)).filter((n) => n.length >= 3);
    const totalLen = segNorms.reduce((s, n) => s + n.length, 0);
    if (segNorms.length === rawSegs.length && totalLen >= 6) {
      const hits = segNorms.map((n) => index.norm.indexOf(n));
      if (hits.every((h) => h >= 0)) return { quote, status: 'verified', composite: true, ...locate(index, hits[0]) };
    }
  }
  return { quote, status: 'missing' };
}

// 純函式核心(可測試):給定語料原文與一份 md,回傳每句引語的驗證結果
export function verifyQuotes(corpusRaw, mdText) {
  const index = buildCorpusIndex(corpusRaw);
  return extractQuotes(mdText).map((q) => checkQuote(index, q));
}

// 整個人物全掃:persona.md + 各調研檔(quality-report 是稽核輸出,略過)
export async function verifyCharacterQuotes(characterId) {
  getCharacter(characterId);
  const corpus = await loadCorpus(characterId);
  if (!corpus.docs.length) {
    throw Object.assign(new Error('sources 中沒有可解析的語料,無從驗證。'), { status: 400 });
  }
  const index = buildCorpusIndex(corpusToPrompt(corpus));
  const targets = [];
  const persona = readPersona(characterId);
  if (persona) targets.push({ target: 'persona.md', text: persona });
  for (const f of listResearch(characterId)) {
    if (f === 'quality-report.md') continue;
    const text = readResearch(characterId, f);
    if (text) targets.push({ target: f, text });
  }
  const results = targets.map(({ target, text }) => {
    const quotes = extractQuotes(text).map((q) => checkQuote(index, q));
    const verified = quotes.filter((q) => q.status === 'verified').length;
    const missing = quotes.filter((q) => q.status === 'missing').length;
    const skipped = quotes.filter((q) => q.status === 'skipped').length;
    return { target, verified, missing, skipped, quotes };
  });
  const total = results.reduce(
    (s, r) => ({ verified: s.verified + r.verified, missing: s.missing + r.missing, skipped: s.skipped + r.skipped }),
    { verified: 0, missing: 0, skipped: 0 }
  );
  return { total, results };
}

// 給演化評分者用的確定性摘要:只驗 persona,回傳可直接嵌入提示詞的文字
export async function personaQuoteAudit(characterId) {
  const persona = readPersona(characterId);
  if (!persona) return null;
  const corpus = await loadCorpus(characterId);
  if (!corpus.docs.length) return null;
  const results = verifyQuotes(corpusToPrompt(corpus), persona);
  const missing = results.filter((r) => r.status === 'missing').map((r) => r.quote);
  const verified = results.filter((r) => r.status === 'verified').length;
  return { verified, missing, checked: results.filter((r) => r.status !== 'skipped').length };
}

// 語錄冊:直接從原始語料取「此人物」的真實發言(依月份分組)——每一句天生可溯源
export async function buildQuotebook(characterId) {
  const character = getCharacter(characterId);
  const keys = [character.name, ...(character.aliases || [])]
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => s.length >= 2);
  const isSubject = (sp) => {
    const s = sp.trim().toLowerCase();
    return keys.some((k) => s === k || s.includes(k) || k.includes(s));
  };
  const byMonth = new Map();
  let count = 0;
  for (const f of listSourceFiles(characterId)) {
    let text;
    try { text = await extractFile(path.join(sourcesDir(characterId), f.name)); } catch { continue; }
    if (!text || !looksLikeChatExport(text)) continue;
    for (const e of parseChatEvents(text)) {
      if (!e.date || e.media || !e.speaker || !isSubject(e.speaker)) continue;
      const clean = e.text.replace(/\s+/g, ' ').trim();
      if (normalizeForMatch(clean).length < 12) continue; // 只收有內容的句子,略過「好」「嗯嗯」
      const m = e.date.match(/^(\d{4})\/(\d{1,2})\//);
      if (!m) continue;
      const ym = `${m[1]}-${String(m[2]).padStart(2, '0')}`;
      if (!byMonth.has(ym)) byMonth.set(ym, []);
      const bucket = byMonth.get(ym);
      if (bucket.length < 200 && count < 3000) { bucket.push({ date: e.date, text: clean.slice(0, 300) }); count++; }
    }
  }
  return {
    name: character.name,
    months: [...byMonth.keys()].sort().map((ym) => ({ ym, quotes: byMonth.get(ym) })),
    count,
  };
}
