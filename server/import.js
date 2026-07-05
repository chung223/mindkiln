import { createCharacter, updateCharacter, writePersona, writeResearchFile } from './store.js';

// nuwa-skill 匯出的標準 6 維度研究檔
const RESEARCH_FILES = [
  '01-writings.md', '02-conversations.md', '03-expression-dna.md',
  '04-external-views.md', '05-decisions.md', '06-timeline.md',
];
// persona 主檔可能的命名
const PERSONA_CANDIDATES = ['SKILL.md', 'persona.md', 'PERSONA.md', 'skill.md', 'Persona.md'];
// research 目錄可能的位置
const RESEARCH_DIRS = ['references/research', 'research', 'references'];
const MAX_BYTES = 500_000;

// 提示詞注入掃描:匯入的 persona 會成為系統提示的一部分,別人寫的檔案可能夾帶惡意指令。
// 命中不阻擋(可能誤判),但要求使用者過目確認後才匯入。
const INJECTION_PATTERNS = [
  [/ignore\s+(?:(?:all|any|the|your|previous|above|prior|earlier)\s+)+(instructions?|prompts?|rules?)/i, '要求忽略先前指示'],
  [/disregard\s+(?:(?:all|any|the|your|previous|above|prior|earlier)\s+)+(instructions?|prompts?|rules?)/i, '要求無視指示'],
  [/忽略(以上|之前|先前|上面|所有|全部)(的)?(指示|指令|規則|提示詞|系統提示)/, '要求忽略指示'],
  [/(不要|不得|禁止|絕不)(向使用者|對使用者)?(透露|提及|洩露|承認).{0,16}(系統|提示詞|指令|這段)/, '要求隱瞞系統提示'],
  [/do\s+not\s+(reveal|mention|disclose|acknowledge)\s+(this|these|the)\s+(instructions?|prompts?)/i, '要求隱瞞指示'],
  [/(you\s+are\s+no\s+longer|from\s+now\s+on,?\s+you\s+(are|must|will))/i, '嘗試覆寫角色'],
  [/<script[\s>]/i, '內嵌 script 標籤'],
  [/(fetch|curl|wget|XMLHttpRequest|axios)\s*\(?\s*['"`]?https?:\/\//i, '指示對外部網址發請求'],
  [/(傳送|發送|上傳|回報|轉發)(使用者|對話|以下|所有)?(的)?(內容|資料|訊息|紀錄).{0,20}(http|網址|伺服器|信箱)/, '指示外傳資料'],
  [/base64,[A-Za-z0-9+/=]{200,}/, '夾帶可疑的長 base64 內容'],
];

export function scanInjection(text) {
  const hits = [];
  for (const [re, label] of INJECTION_PATTERNS) {
    const m = String(text || '').match(re);
    if (m) hits.push(`${label}:「${m[0].slice(0, 60)}」`);
  }
  return hits;
}

// 只從 github.com / raw.githubusercontent.com 解析出 owner/repo,其餘一律拒絕
function parseGithubRepo(input) {
  const s = String(input || '').trim();
  const m =
    s.match(/^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/i) ||
    s.match(/^https?:\/\/raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, '');
  // 防呆:owner/repo 僅允許安全字元(regex 已限制,再保險一次)
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo };
}

// 固定 host(raw.githubusercontent.com)、固定路徑樣式;redirect:error 阻擋轉址型 SSRF
async function fetchRaw(owner, repo, branch, filePath) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
  let res;
  try {
    res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new Error(`檔案過大(${filePath})`);
  return text;
}

// 剝掉 YAML frontmatter,回傳本文與 meta(name / description)
function stripFrontmatter(md) {
  const m = md.match(/^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: md, meta: {} };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([\w-]+)\s*:\s*(.+)$/);
    if (mm) meta[mm[1].trim()] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return { body: md.slice(m[0].length), meta };
}

/**
 * 匯入一個 nuwa-skill 格式的人物:
 *  - body.url:GitHub 儲存庫網址 → 拉取 SKILL.md/persona.md + references/research/*
 *  - body.personaText:直接貼上的 persona 文字
 * 建立一個 status=ready 的人物(免蒸餾)。
 */
export async function handleImport(req, res) {
  const { name, url, personaText } = req.body || {};
  let persona = '';
  let derivedName = (name || '').trim();
  let note = '';
  let sourceLabel = '';
  const research = {};

  if (personaText && personaText.trim()) {
    const { body, meta } = stripFrontmatter(personaText);
    persona = body.trim();
    if (!derivedName) derivedName = (meta.name || '').trim();
    note = (meta.description || '').trim();
    sourceLabel = '貼上匯入';
  } else if (url && url.trim()) {
    const repo = parseGithubRepo(url);
    if (!repo) {
      res.status(400).json({ error: '請提供 GitHub 儲存庫網址(https://github.com/擁有者/專案)' });
      return;
    }
    let raw = null;
    let branchUsed = null;
    for (const branch of ['main', 'master']) {
      for (const cand of PERSONA_CANDIDATES) {
        raw = await fetchRaw(repo.owner, repo.repo, branch, cand);
        if (raw) { branchUsed = branch; break; }
      }
      if (raw) break;
    }
    if (!raw) {
      res.status(400).json({ error: '在該儲存庫找不到 SKILL.md 或 persona.md(需為 nuwa-skill 格式)' });
      return;
    }
    const { body, meta } = stripFrontmatter(raw);
    persona = body.trim();
    if (!derivedName) derivedName = (meta.name || repo.repo).trim();
    note = (meta.description || '').trim();
    sourceLabel = `github.com/${repo.owner}/${repo.repo}`;
    // 研究檔(best-effort,嘗試常見目錄)
    for (const f of RESEARCH_FILES) {
      for (const d of RESEARCH_DIRS) {
        const r = await fetchRaw(repo.owner, repo.repo, branchUsed, `${d}/${f}`);
        if (r) { research[f] = r; break; }
      }
    }
  } else {
    res.status(400).json({ error: '請提供 GitHub 網址,或直接貼上 persona 文字' });
    return;
  }

  if (!derivedName) {
    res.status(400).json({ error: '請填入人物名稱' });
    return;
  }
  if (!persona || persona.length < 50) {
    res.status(400).json({ error: 'persona 內容太短或抓取失敗,請確認來源是 nuwa-skill 格式' });
    return;
  }

  // 注入掃描:別人寫的 persona 會進系統提示,可疑指令須經使用者確認
  const warnings = scanInjection(persona);
  if (warnings.length && !req.body?.force) {
    res.json({ needsConfirm: true, warnings });
    return;
  }

  const char = createCharacter({ name: derivedName, note, subjectType: 'public' });
  const stamp = `\n\n---\n> 由外部 nuwa-skill 匯入${sourceLabel ? `(${sourceLabel})` : ''}｜匯入時間:${new Date().toISOString().slice(0, 10)}\n`;
  writePersona(char.id, persona + stamp);
  for (const [f, content] of Object.entries(research)) writeResearchFile(char.id, f, content);
  updateCharacter(char.id, { status: 'ready', distilledAt: new Date().toISOString() });

  res.json({ id: char.id, name: char.name, researchCount: Object.keys(research).length });
}
