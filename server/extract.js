import fs from 'fs';
import path from 'path';
// pdf-parse 1.x：直接匯入內部模組以避開其 index.js 的 debug 模式副作用
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import mammoth from 'mammoth';
import { sourcesDir, listSourceFiles, readConfig } from './store.js';
import { getModel, getProvider } from './llm.js';

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.text', '.json', '.csv', '.tsv', '.log',
  '.htm', '.html', '.xml', '.yaml', '.yml',
]);
const SUB_EXTS = new Set(['.srt', '.vtt']);

// ---------- 聊天匯出清洗(WeChat / LINE / WhatsApp) ----------

// 系統訊息(整行丟棄)
const CHAT_NOISE = [
  /端對端加密|end-to-end encrypted|end to end encrypted/i,
  /訊息和通話都會經過端對端加密|你已建立群組|建立了群組|加入了群組|邀請.*加入|移出了群組/,
  /撤回了一(條|则|條)訊息|收回了一則訊息|unsent a message|deleted this message|此訊息已刪除/i,
];
// 媒體佔位符(整段訊息就只有這個時丟棄)
const MEDIA_ONLY = /^\s*[<\[(]?\s*(媒體|媒体|照片|圖片|图片|貼圖|贴图|表情|動畫貼圖|影片|视频|語音|语音|檔案|文件|位置|名片|Media omitted|Photo|Video|Sticker|Image|GIF|Voice|Audio|File|Location|已收回|撤回|貼圖已刪除)\s*[>\])]?\s*$/i;

// 各平台的「時間戳 + 發言者:」行首樣式
const CHAT_LINE_PATTERNS = [
  // WhatsApp: [2023/5/1, 14:03:22] 阿明: 訊息  或  2023/5/1, 14:03 - 阿明: 訊息
  { re: /^\s*\[?\d{1,4}[/.\-]\d{1,2}[/.\-]\d{1,2}[,\s]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[APap][Mm])?\]?\s*[-–]?\s*([^:：]{1,40})[:：]\s*(.*)$/ },
  // LINE 匯出: 時間<Tab>名字<Tab>訊息  (例:  下午 2:03\t阿明\t訊息)
  { re: /^\s*(?:上午|下午|AM|PM)?\s*\d{1,2}:\d{2}\t([^\t]{1,40})\t(.*)$/ },
  // 泛用: 名字: 訊息(需夠短的名字,避免誤判一般冒號句)
  { re: /^\s*([\p{L}\p{N}_@.\- ]{1,20})[:：]\s+(.+)$/u, weak: true },
];

export function looksLikeChatExport(text) {
  const lines = text.split(/\r?\n/).slice(0, 60).filter((l) => l.trim());
  if (lines.length < 5) return false;
  let hits = 0;
  for (const l of lines) {
    if (CHAT_LINE_PATTERNS.slice(0, 2).some((p) => p.re.test(l))) hits++;
  }
  return hits >= Math.max(3, lines.length * 0.3);
}

// 把聊天匯出清成統一的「發言者: 內容」串流,並丟掉系統/媒體噪音
export function normalizeChatExport(text) {
  const out = [];
  let lastSpeaker = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/​/g, '').trimEnd();
    if (!line.trim()) continue;
    if (CHAT_NOISE.some((re) => re.test(line))) continue;
    let matched = false;
    for (const p of CHAT_LINE_PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        const speaker = m[1].trim();
        const msg = (m[2] || '').trim();
        matched = true;
        if (!msg || MEDIA_ONLY.test(msg)) {
          lastSpeaker = null; // 丟棄此訊息:後續續行不可誤掛到這位發言者
          break;
        }
        out.push(`${speaker}: ${msg}`);
        lastSpeaker = speaker;
        break;
      }
    }
    if (!matched) {
      // 續行(同一發言者的多行訊息)
      if (lastSpeaker) out.push(line.trim());
      else out.push(line.trim());
    }
  }
  return out.join('\n');
}

// 從語料掃出候選發言者(標籤 + @帳號),依出現頻率排序。
// minCount 用來過濾雜訊;跨多檔聚合時應傳 1,待聚合後再一次過濾。
export function detectSpeakers(text, minCount = 2) {
  const counts = new Map();
  const bump = (name) => {
    const n = name.trim();
    if (!n || n.length > 24) return;
    counts.set(n, (counts.get(n) || 0) + 1);
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    for (const p of CHAT_LINE_PATTERNS) {
      const m = line.match(p.re);
      if (m) { bump(m[1]); break; }
    }
    for (const h of line.matchAll(/@([\p{L}\p{N}_.\-]{2,24})/gu)) bump('@' + h[1]);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= minCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, count]) => ({ name, count }));
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function stripSubtitles(raw) {
  const lines = raw.split(/\r?\n/);
  const out = [];
  let prev = '';
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    if (/^\d+$/.test(line)) continue; // srt counter
    if (/^WEBVTT/i.test(line)) continue;
    if (/-->/.test(line)) continue; // timestamp line
    line = line.replace(/<[^>]+>/g, '').trim();
    if (!line || line === prev) continue;
    out.push(line);
    prev = line;
  }
  return out.join('\n');
}

export async function extractFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (SUB_EXTS.has(ext)) {
    return stripSubtitles(fs.readFileSync(filePath, 'utf8'));
  }
  if (ext === '.pdf') {
    const data = await pdfParse(fs.readFileSync(filePath));
    return data.text || '';
  }
  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || '';
  }
  if (TEXT_EXTS.has(ext)) {
    const raw = fs.readFileSync(filePath, 'utf8');
    return ext === '.html' || ext === '.htm' ? stripHtml(raw) : raw;
  }
  // unknown extension: try utf8, reject if it looks binary
  const buf = fs.readFileSync(filePath);
  const sample = buf.subarray(0, 4096);
  let control = 0;
  for (const b of sample) {
    if (b === 0) return null;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  if (control > sample.length * 0.05) return null;
  return buf.toString('utf8');
}

// 語料字數上限,依模型上下文窗口決定。CJK 約 1 字 ≈ 1 token,故遠低於窗口,
// 保留空間給提示詞與輸出。haiku 只有 200K 窗口,須用更小的預算。
const CHAR_BUDGETS = { 'claude-haiku-4-5': 90_000 };
const DEFAULT_CHAR_BUDGET = 500_000; // 1M 窗口模型(opus-4-8 / sonnet-5 / fable-5)
const LOCAL_CHAR_BUDGET = 120_000; // 本地模型上下文通常較小,保守取值

export function corpusCharBudget() {
  const cfg = readConfig();
  if (cfg.corpusBudget) return Number(cfg.corpusBudget); // 使用者可於設定手動覆寫
  const provider = getProvider();
  if (provider === 'openai') return LOCAL_CHAR_BUDGET;
  if (provider === 'compat') {
    // MiniMax-M3 為 1M 上下文,其餘 M2.x 較小,保守取值
    return /M3/i.test(getModel()) ? DEFAULT_CHAR_BUDGET : 200_000;
  }
  return CHAR_BUDGETS[getModel()] ?? DEFAULT_CHAR_BUDGET;
}

export async function loadCorpus(characterId) {
  const CORPUS_CHAR_BUDGET = corpusCharBudget();
  const files = listSourceFiles(characterId);
  const docs = [];
  const skipped = [];
  for (const f of files) {
    const full = path.join(sourcesDir(characterId), f.name);
    try {
      let text = await extractFile(full);
      if (text === null || !text.trim()) {
        skipped.push({ name: f.name, reason: '無法解析或內容為空' });
        continue;
      }
      // 聊天匯出檔:清成統一「發言者: 內容」並去除系統/媒體噪音
      if (looksLikeChatExport(text)) text = normalizeChatExport(text);
      docs.push({ name: f.name, text: text.trim() });
    } catch (err) {
      skipped.push({ name: f.name, reason: err.message });
    }
  }

  let total = docs.reduce((s, d) => s + d.text.length, 0);
  let truncated = false;
  if (total > CORPUS_CHAR_BUDGET) {
    truncated = true;
    const ratio = CORPUS_CHAR_BUDGET / total;
    for (const d of docs) {
      const keep = Math.max(2000, Math.floor(d.text.length * ratio));
      if (d.text.length > keep) {
        d.text = d.text.slice(0, keep) + '\n\n…（本文件因總語料超出上限而被截斷）';
      }
    }
    total = docs.reduce((s, d) => s + d.text.length, 0);
    // 2000 字下限在文件數眾多時可能仍超出預算,做第二輪無下限等比裁切
    if (total > CORPUS_CHAR_BUDGET) {
      const r2 = CORPUS_CHAR_BUDGET / total;
      for (const d of docs) d.text = d.text.slice(0, Math.floor(d.text.length * r2));
      total = docs.reduce((s, d) => s + d.text.length, 0);
    }
  }

  return { docs, skipped, totalChars: total, truncated };
}

export function corpusToPrompt(corpus) {
  return corpus.docs
    .map((d) => `<document filename="${d.name}">\n${d.text}\n</document>`)
    .join('\n\n');
}

// 掃某人物全部語料,回傳候選發言者(供使用者勾選為別名)
export async function detectSpeakersForCharacter(characterId) {
  const files = listSourceFiles(characterId);
  const counts = new Map();
  for (const f of files) {
    const full = path.join(sourcesDir(characterId), f.name);
    try {
      let text = await extractFile(full);
      if (!text) continue;
      if (looksLikeChatExport(text)) text = normalizeChatExport(text);
      // 每檔取原始計數(minCount=1),待跨檔聚合後再一次過濾,避免薄分佈的發言者被逐檔門檻濾掉
      for (const { name, count } of detectSpeakers(text, 1)) {
        counts.set(name, (counts.get(name) || 0) + count);
      }
    } catch {
      /* 略過無法解析的檔 */
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, count]) => ({ name, count }));
}

// 蒸餾前的乾跑估算:只讀語料、不呼叫模型
export async function estimateDistillation(characterId, gear) {
  const corpus = await loadCorpus(characterId);
  const dims = gear === 'quick' ? 3 : 6;
  const calls = dims + 3; // 各維度 + 綜合 + 品質稽核 + persona 組裝
  // CJK 約 1 字 ≈ 1 token;維度呼叫各讀一次語料,綜合/persona 讀小份調研包
  const perDimTokens = corpus.totalChars;
  const estInputTokens = perDimTokens * dims + Math.round(corpus.totalChars * 0.5);
  return {
    files: corpus.docs.map((d) => ({ name: d.name, chars: d.text.length })),
    skipped: corpus.skipped,
    totalChars: corpus.totalChars,
    truncated: corpus.truncated,
    dimensions: dims,
    modelCalls: calls,
    estInputTokens,
  };
}
