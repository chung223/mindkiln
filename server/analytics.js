import fs from 'fs';
import path from 'path';
import { getCharacter, listSourceFiles, sourcesDir, researchDir } from './store.js';
import { extractFile, parseChatEvents, looksLikeChatExport } from './extract.js';
import { streamChat } from './llm.js';
import { emotionalArcPrompt } from './prompts.js';
import { toTraditional, shouldForceTraditional } from './zhtw.js';

// 發言者是否屬於「此人物」:名稱/別名與發言標籤互為包含即算(涵蓋「古某某 Ruth」vs「古某某」)
function speakerMatcher(character) {
  const keys = [character.name, ...(character.aliases || [])]
    .map((s) => String(s).trim().toLowerCase())
    .filter((s) => s.length >= 2);
  return (speaker) => {
    const sp = speaker.trim().toLowerCase();
    return keys.some((k) => sp === k || sp.includes(k) || k.includes(sp));
  };
}

const ymOf = (date) => {
  const m = date.match(/^(\d{4})\/(\d{1,2})\//);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}` : null;
};

/** 純計算(零模型成本):把人物語料中的聊天匯出彙整成關係統計。 */
export async function computeAnalytics(characterId) {
  const character = getCharacter(characterId);
  const isSubject = speakerMatcher(character);
  const files = listSourceFiles(characterId);

  const perFileEvents = [];
  const skipped = [];
  for (const f of files) {
    try {
      const text = await extractFile(path.join(sourcesDir(characterId), f.name));
      if (!text || !looksLikeChatExport(text)) { skipped.push(f.name); continue; }
      const ev = parseChatEvents(text).filter((e) => e.speaker);
      if (ev.length) perFileEvents.push({ file: f.name, events: ev });
      else skipped.push(f.name);
    } catch { skipped.push(f.name); }
  }

  const monthly = new Map(); // ym -> {subject, other}
  const hourHist = { subject: new Array(24).fill(0), other: new Array(24).fill(0) };
  const initiations = { subject: 0, other: 0 };
  const lateNight = { subject: 0, other: 0 };
  const totals = { subject: 0, other: 0, subjectChars: 0, otherChars: 0, media: 0 };
  const lenMonthly = new Map(); // ym -> {subjectChars, subjectN, otherChars, otherN}
  const speakerCounts = new Map();
  const dates = new Set();
  let minDate = null, maxDate = null;

  const dateKeyNum = (d) => {
    const m = d.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
    return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : null;
  };

  for (const { events } of perFileEvents) {
    let lastDate = null;
    for (const e of events) {
      const bucket = isSubject(e.speaker) ? 'subject' : 'other';
      speakerCounts.set(e.speaker, (speakerCounts.get(e.speaker) || 0) + 1);
      totals[bucket]++;
      if (e.media) totals.media++;
      else totals[bucket + 'Chars'] += e.text.length;
      if (e.date) {
        dates.add(e.date);
        const n = dateKeyNum(e.date);
        if (n) {
          if (!minDate || n < dateKeyNum(minDate)) minDate = e.date;
          if (!maxDate || n > dateKeyNum(maxDate)) maxDate = e.date;
        }
        const ym = ymOf(e.date);
        if (ym) {
          if (!monthly.has(ym)) monthly.set(ym, { subject: 0, other: 0 });
          monthly.get(ym)[bucket]++;
          if (!e.media) {
            if (!lenMonthly.has(ym)) lenMonthly.set(ym, { subjectChars: 0, subjectN: 0, otherChars: 0, otherN: 0 });
            const L = lenMonthly.get(ym);
            L[bucket + 'Chars'] += e.text.length;
            L[bucket + 'N']++;
          }
        }
        if (e.date !== lastDate) { initiations[bucket]++; lastDate = e.date; } // 當日第一則 = 開場
      }
      if (e.hour != null) {
        hourHist[bucket][e.hour]++;
        if (e.hour >= 23 || e.hour <= 5) lateNight[bucket]++;
      }
    }
  }

  const months = [...monthly.keys()].sort();
  const topSpeakers = [...speakerCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, count]) => ({ name, count, isSubject: isSubject(name) }));
  const otherTop = topSpeakers.find((s) => !s.isSubject);

  // 已生成過的情感弧線(快取於 research/)
  let arc = null;
  try {
    const p = path.join(researchDir(characterId), 'emotional-arc.json');
    if (fs.existsSync(p)) arc = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { /* 壞檔視同無 */ }

  return {
    subjectLabel: character.name,
    otherLabel: otherTop ? otherTop.name : '對方',
    files: perFileEvents.map((x) => ({ name: x.file, events: x.events.length })),
    skipped,
    range: { from: minDate, to: maxDate, activeDays: dates.size },
    totals,
    months: months.map((ym) => {
      const m = monthly.get(ym);
      const L = lenMonthly.get(ym) || { subjectChars: 0, subjectN: 0, otherChars: 0, otherN: 0 };
      return {
        ym,
        subject: m.subject,
        other: m.other,
        subjectAvgLen: L.subjectN ? Math.round(L.subjectChars / L.subjectN) : 0,
        otherAvgLen: L.otherN ? Math.round(L.otherChars / L.otherN) : 0,
      };
    }),
    hourHist,
    initiations,
    lateNight,
    topSpeakers,
    arc,
  };
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

/** 情感弧線(一次模型呼叫,結果落盤快取):每月基調 + 效價 + 轉折點。 */
export async function computeEmotionalArc(characterId, { signal } = {}) {
  const character = getCharacter(characterId);
  const isSubject = speakerMatcher(character);
  const files = listSourceFiles(characterId);
  const byMonth = new Map();
  for (const f of files) {
    let text;
    try { text = await extractFile(path.join(sourcesDir(characterId), f.name)); } catch { continue; }
    if (!text || !looksLikeChatExport(text)) continue;
    for (const e of parseChatEvents(text)) {
      if (!e.date || e.media || !e.text) continue;
      const ym = ymOf(e.date);
      if (!ym) continue;
      if (!byMonth.has(ym)) byMonth.set(ym, []);
      byMonth.get(ym).push(`${isSubject(e.speaker) ? 'S' : 'U'}: ${e.text.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }
  const months = [...byMonth.keys()].sort().slice(-24); // 最多 24 個月
  if (!months.length) throw Object.assign(new Error('語料中沒有可辨識日期的聊天內容,無法生成情感弧線。'), { status: 400 });
  const sample = months.map((ym) => {
    const all = byMonth.get(ym);
    const step = Math.max(1, Math.floor(all.length / 24)); // 每月均勻取樣至多 ~24 句
    const pick = all.filter((_, i) => i % step === 0).slice(0, 24);
    return `## ${ym}(共 ${all.length} 則,取樣 ${pick.length})\n${pick.join('\n')}`;
  }).join('\n\n');

  const r = await streamChat({
    system: [{ type: 'text', text: emotionalArcPrompt(character.name) }],
    messages: [{ role: 'user', content: `S=「${character.name}」,U=對話的另一方。逐月取樣如下:\n\n${sample}` }],
    maxTokens: 4000,
    signal,
  });
  const json = extractJsonBlock(r.text);
  if (!json) throw new Error('模型未回傳可解析的情感弧線結果,請重試。');
  let parsed;
  try { parsed = JSON.parse(json); } catch { throw new Error('模型未回傳可解析的情感弧線結果,請重試。'); }
  const trad = shouldForceTraditional(character);
  const conv = (s) => (trad && typeof s === 'string' ? toTraditional(s) : s);
  const arc = {
    generatedAt: new Date().toISOString(),
    months: (Array.isArray(parsed.months) ? parsed.months : []).map((m) => ({
      ym: String(m.ym || ''),
      valence: Math.max(-2, Math.min(2, Number(m.valence) || 0)),
      tone: conv(String(m.tone || '')),
    })),
    turningPoints: (Array.isArray(parsed.turningPoints) ? parsed.turningPoints : []).slice(0, 8).map((t) => ({
      date: String(t.date || ''),
      label: conv(String(t.label || '')),
    })),
  };
  fs.mkdirSync(researchDir(characterId), { recursive: true });
  fs.writeFileSync(path.join(researchDir(characterId), 'emotional-arc.json'), JSON.stringify(arc, null, 2));
  return arc;
}
