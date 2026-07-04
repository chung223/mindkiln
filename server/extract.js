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

// iOS / LINE 匯出常在行首插入不可見的雙向控制字元,先清掉再比對
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;
const stripInvisible = (s) => s.replace(INVISIBLE, '');
// 中文時間常見「晚上 9:44」「凌晨 12:25」等,時分前可帶中文時段詞
const MERIDIEM = '(?:上午|下午|凌晨|清晨|早上|中午|晚上|傍晚|夜間|AM|PM)';

// 各平台的「時間戳 + 發言者:」行首樣式(比對前已 stripInvisible)
const CHAT_LINE_PATTERNS = [
  // WhatsApp / iOS: [2023/5/1, 14:03:22] 阿明: 訊息  ·  [2026/2/24 晚上9:44:29] 小美: 訊息  ·  2023/5/1, 14:03 - 阿明: 訊息
  { re: new RegExp(`^\\s*\\[?\\d{1,4}[/.\\-]\\d{1,2}[/.\\-]\\d{1,2}[,\\s]+${MERIDIEM}?\\s*\\d{1,2}:\\d{2}(?::\\d{2})?\\s*${MERIDIEM}?\\]?\\s*[-–]?\\s*([^:：]{1,40})[:：]\\s*(.*)$`) },
  // LINE 匯出: 時間<Tab>名字<Tab>訊息  (例:  下午 2:03\t阿明\t訊息)
  { re: new RegExp(`^\\s*${MERIDIEM}?\\s*\\d{1,2}:\\d{2}\\t([^\\t]{1,40})\\t(.*)$`) },
  // 泛用: 名字: 訊息(需夠短的名字,避免誤判一般冒號句)
  { re: /^\s*([\p{L}\p{N}_@.\- ]{1,20})[:：]\s+(.+)$/u, weak: true },
];

// 行首的日期(WhatsApp 內嵌 或 LINE 獨立表頭),抓出來當時間線錨點
const DATE_AT_START = /^\s*\[?(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})\b/;
// LINE 匯出常把日期單獨放一行:「2025/12/11(週四)」「2026/7/1（星期二）」「2025.02.24 星期一」
// 日期分隔支援 / . -;尾綴可為括號組 (週四)/（星期二） 或裸「星期X」「週X」(點分隔匯出常見)
const DATE_HEADER = /^\s*(\d{4})[/.\-](\d{1,2})[/.\-](\d{1,2})\s*(?:[（(【][^)）】]*[)）】]|星期[一二三四五六日天]|週[一二三四五六日天])?\s*$/;

// ---------- 空格分隔的 LINE 匯出變體 ----------
// 形如「HH:MM 發言者 訊息」,時間、發言者、訊息全以空白分隔,且發言者名字本身可能含空格
// (例:「15:01 古惠如 Ruth 08-777-2007」)。名字/訊息邊界模糊,故先掃全檔找出「反覆
// 出現的名字前綴」再據以切分;偵測門檻刻意設高(高比例行以 HH:MM 開頭 + 至少兩位反覆
// 出現的發言者),以免把帶時間戳的一般文件(行程表、日誌、散文)誤判為聊天而污染語料。
const SPACE_LINE_RE = new RegExp(`^\\s*${MERIDIEM}?\\s*\\d{1,2}:\\d{2}(?::\\d{2})?\\s+(\\S.*)$`);
// 合格的名字 token:以字母(任一語系,含中日文)開頭且不過長;可濾掉電話、#標籤、[日誌等級]
const nameTokenOk = (t) => t.length <= 16 && /^\p{L}/u.test(t);

// 依「名字在該發言者所有訊息中固定不變」的特性,推斷名字佔幾個 token(1–3)。
function spaceNameLength(group) {
  let len = 1;
  for (let pos = 1; pos < 3; pos++) {
    const counts = new Map();
    let considered = 0;
    for (const toks of group) {
      if (toks.length <= pos) continue;
      considered++;
      counts.set(toks[pos], (counts.get(toks[pos]) || 0) + 1);
    }
    if (considered < 3) break; // 樣本太少,不敢貿然把此位置併入名字
    let best = null;
    let bestCount = 0;
    for (const [v, c] of counts) if (c > bestCount) { best = v; bestCount = c; }
    // 只有此位置幾乎總是同一個 token(≥0.8)且該 token 像名字、非媒體佔位符時才納入名字
    if (best != null && bestCount / considered >= 0.8 && nameTokenOk(best) && !MEDIA_ONLY.test(best)) {
      len = pos + 1;
    } else break;
  }
  return len;
}

// 掃全檔判斷是否為此變體。回傳 Map<名字首 token, 名字 token 數>;不像此格式則回傳 null。
function detectSpaceLineExport(text) {
  let nonEmpty = 0;
  let timeLines = 0;
  let dateLines = 0;
  const groups = new Map(); // 名字首 token -> 該發言者各行的完整 token 陣列
  for (const raw of text.split(/\r?\n/)) {
    const line = stripInvisible(raw).trim();
    if (!line) continue;
    nonEmpty++;
    if (DATE_HEADER.test(line)) { dateLines++; continue; }
    if (line.includes('\t')) continue; // tab 變體另有樣式處理
    const m = line.match(SPACE_LINE_RE);
    if (!m) continue;
    const tokens = m[1].split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    timeLines++;
    const t1 = tokens[0];
    if (!nameTokenOk(t1)) continue;
    if (!groups.has(t1)) groups.set(t1, []);
    groups.get(t1).push(tokens);
  }
  if (nonEmpty < 8 || timeLines < 5) return null;
  if ((timeLines + dateLines) / nonEmpty < 0.7) return null; // 需高比例行是時間戳訊息/日期表頭
  const speakers = new Map();
  for (const [t1, group] of groups) {
    if (group.length < 2) continue; // 名字須反覆出現,單次者不算
    speakers.set(t1, spaceNameLength(group));
  }
  return speakers.size >= 2 ? speakers : null; // 對話至少要有兩位發言者
}

// 依已偵測的發言者名字表切分一行空格分隔訊息;未知的首 token 退回以 1 個 token 當名字。
function splitSpaceLine(line, speakers) {
  if (line.includes('\t')) return null;
  const m = line.match(SPACE_LINE_RE);
  if (!m) return null;
  const tokens = m[1].split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const nameLen = Math.min(speakers.get(tokens[0]) || 1, tokens.length);
  return { speaker: tokens.slice(0, nameLen).join(' '), msg: tokens.slice(nameLen).join(' ') };
}

export function looksLikeChatExport(text) {
  const lines = text.split(/\r?\n/).slice(0, 60).map(stripInvisible).filter((l) => l.trim());
  if (lines.length >= 5) {
    let hits = 0;
    for (const l of lines) {
      if (CHAT_LINE_PATTERNS.slice(0, 2).some((p) => p.re.test(l))) hits++;
    }
    if (hits >= Math.max(3, lines.length * 0.3)) return true;
  }
  // 空格分隔的 LINE 匯出變體(整份高比例行以 HH:MM 開頭 + 反覆出現的發言者)
  return detectSpaceLineExport(text) !== null;
}

// 把聊天匯出清成統一的「發言者: 內容」串流,並丟掉系統/媒體噪音。
// 保留「日期錨點」(訊息時分不留,但日期換行時插入「—— YYYY/M/D ——」分隔),
// 讓時間線維度能可靠地把每段對話對應到正確日期。
export function normalizeChatExport(text) {
  const out = [];
  const spaceSpeakers = detectSpaceLineExport(text); // 空格分隔 LINE 變體的發言者名字表(否則 null)
  let lastSpeaker = null;
  let currentDate = null;
  const emitDate = (y, m, d) => {
    const key = `${y}/${Number(m)}/${Number(d)}`;
    if (key !== currentDate) {
      currentDate = key;
      out.push(`—— ${key} ——`);
      lastSpeaker = null; // 換日:續行不可跨日誤掛
    }
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = stripInvisible(raw).trimEnd();
    if (!line.trim()) continue;
    // 純日期表頭行(LINE 格式:日期單獨一行)
    const dh = line.match(DATE_HEADER);
    if (dh) { emitDate(dh[1], dh[2], dh[3]); continue; }
    if (CHAT_NOISE.some((re) => re.test(line))) continue;
    // 空格分隔 LINE 變體:用預掃的發言者名字表切分,避免泛用弱樣式把散文行誤判為聊天
    if (spaceSpeakers) {
      const sm = splitSpaceLine(line, spaceSpeakers);
      if (sm) {
        const msg = sm.msg.trim();
        if (!msg || MEDIA_ONLY.test(msg)) { lastSpeaker = null; continue; }
        out.push(`${sm.speaker}: ${msg}`);
        lastSpeaker = sm.speaker;
        continue;
      }
      out.push(line.trim()); // 非時間行:視為上一則訊息的續行
      continue;
    }
    let matched = false;
    for (const p of CHAT_LINE_PATTERNS) {
      const m = line.match(p.re);
      if (m) {
        const dm = line.match(DATE_AT_START); // WhatsApp 行首內嵌日期
        if (dm) emitDate(dm[1], dm[2], dm[3]);
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
      out.push(line.trim());
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
