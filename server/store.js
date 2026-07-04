import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 資料存放位置可用環境變數 NUWA_DATA_DIR 指定(留空則預設專案內的 data/)。
// 開源時把資料放到 repo 外(如 ~/nuwa-data 或雲端同步資料夾)較乾淨,也避免誤入版控。
export const DATA_DIR = process.env.NUWA_DATA_DIR
  ? path.resolve(process.env.NUWA_DATA_DIR)
  : path.join(ROOT, 'data');
export const CHARACTERS_DIR = path.join(DATA_DIR, 'characters');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

fs.mkdirSync(CHARACTERS_DIR, { recursive: true });

// 原子寫入:先寫暫存檔再 rename,避免寫到一半崩潰留下半截 JSON
function atomicWrite(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// ---------- config ----------

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function writeConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  for (const k of Object.keys(cfg)) {
    if (cfg[k] === null || cfg[k] === '') delete cfg[k];
  }
  atomicWrite(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  return cfg;
}

// ---------- characters ----------

export function slugify(name) {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'character';
}

function uniqueSlug(name) {
  let slug = slugify(name);
  let candidate = slug;
  let i = 2;
  while (fs.existsSync(path.join(CHARACTERS_DIR, candidate))) {
    candidate = `${slug}-${i++}`;
  }
  return candidate;
}

export function characterDir(id) {
  const safe = path.basename(String(id));
  // path.basename 已剝除路徑分隔符;仍須擋掉 ''、'.'、'..'
  // (path.join(CHARACTERS_DIR, '') / '.' 都會解析回 CHARACTERS_DIR 本身)
  if (!safe || safe === '.' || safe === '..') throw new Error('invalid character id');
  const dir = path.join(CHARACTERS_DIR, safe);
  if (path.dirname(dir) !== CHARACTERS_DIR) throw new Error('invalid character id');
  return dir;
}

export function sourcesDir(id) {
  return path.join(characterDir(id), 'sources');
}

export function researchDir(id) {
  return path.join(characterDir(id), 'research');
}

export function chatsDir(id) {
  return path.join(characterDir(id), 'chats');
}

export function personaPath(id) {
  return path.join(characterDir(id), 'persona.md');
}

function metaPath(id) {
  return path.join(characterDir(id), 'character.json');
}

export function normalizeAliases(aliases) {
  if (Array.isArray(aliases)) return aliases.map((s) => String(s).trim()).filter(Boolean);
  if (typeof aliases === 'string') {
    // 允許以逗號、頓號、換行分隔
    return aliases.split(/[,、\n]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

export const SUBJECT_TYPES = ['public', 'private', 'self', 'fictional'];
export const OUTPUT_LANGUAGES = ['zh-Hant', 'zh-Hans', 'match-corpus', 'en', 'ja'];

export function createCharacter({ name, note, aliases, subjectType, consentAck, outputLanguage }) {
  if (!name || !name.trim()) throw new Error('人物名稱不可為空');
  const id = uniqueSlug(name);
  const dir = characterDir(id);
  fs.mkdirSync(path.join(dir, 'sources'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'research'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
  const meta = {
    id,
    name: name.trim(),
    note: (note || '').trim(),
    aliases: normalizeAliases(aliases), // 語料(尤其多人對話)中此人的稱呼/帳號
    subjectType: SUBJECT_TYPES.includes(subjectType) ? subjectType : 'public',
    consentAck: Boolean(consentAck), // 是否已確認取得當事人同意(私人對象時尤重要)
    outputLanguage: OUTPUT_LANGUAGES.includes(outputLanguage) ? outputLanguage : 'zh-Hant',
    status: 'new', // new | distilling | ready | error
    createdAt: new Date().toISOString(),
    distilledAt: null,
    lastError: null,
  };
  atomicWrite(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

export function getCharacter(id) {
  const raw = fs.readFileSync(metaPath(id), 'utf8');
  return JSON.parse(raw);
}

export function updateCharacter(id, patch) {
  const meta = { ...getCharacter(id), ...patch };
  atomicWrite(metaPath(id), JSON.stringify(meta, null, 2));
  return meta;
}

export function listCharacters() {
  const out = [];
  for (const entry of fs.readdirSync(CHARACTERS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = getCharacter(entry.name);
      meta.sourceCount = listSourceFiles(entry.name).length;
      meta.hasPersona = fs.existsSync(personaPath(entry.name));
      out.push(meta);
    } catch {
      // skip folders without character.json
    }
  }
  out.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return out;
}

export function deleteCharacter(id) {
  fs.rmSync(characterDir(id), { recursive: true, force: true });
}

// ---------- source files ----------

export function listSourceFiles(id) {
  const dir = sourcesDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => {
      const st = fs.statSync(path.join(dir, e.name));
      return { name: e.name, size: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function deleteSourceFile(id, fileName) {
  const p = path.join(sourcesDir(id), path.basename(fileName));
  fs.rmSync(p, { force: true });
}

export function readPersona(id) {
  const p = personaPath(id);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

export function writePersona(id, content) {
  atomicWrite(personaPath(id), content);
}

export function writeResearchFile(id, fileName, content) {
  const dir = researchDir(id);
  fs.mkdirSync(dir, { recursive: true });
  atomicWrite(path.join(dir, path.basename(fileName)), content);
}

export function listResearch(id) {
  const dir = researchDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort();
}

export function readResearch(id, fileName) {
  const p = path.join(researchDir(id), path.basename(fileName));
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

// ---------- chats ----------

export function listChats(id) {
  const dir = chatsDir(id);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const chat = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      out.push({
        id: chat.id,
        title: chat.title,
        mode: chat.mode,
        conditions: chat.conditions,
        messageCount: chat.messages.length,
        updatedAt: chat.updatedAt,
      });
    } catch {
      // skip corrupted chat files
    }
  }
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return out;
}

const CHAT_MODE_SET = new Set(['chat', 'predict', 'rehearse', 'letter', 'perspective', 'reflect', 'training']);
const SCENARIO_SET = new Set(['casual', 'icebreak', 'clarify', 'invite', 'repair', 'boundary', 'confess', 'ambiguity', 'custom']);

export function createChat(charId, { title, mode, conditions, scenario, coachMode }) {
  const m = CHAT_MODE_SET.has(mode) ? mode : 'chat';
  const chat = {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: title || new Date().toLocaleString('zh-TW'),
    mode: m,
    conditions: conditions || {},
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (m === 'training') {
    chat.scenario = SCENARIO_SET.has(scenario) ? scenario : 'custom';
    chat.coachMode = coachMode === 'report' ? 'report' : 'realtime';
  }
  fs.mkdirSync(chatsDir(charId), { recursive: true });
  writeChat(charId, chat);
  return chat;
}

export function getChat(charId, chatId) {
  const p = path.join(chatsDir(charId), `${path.basename(chatId)}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function writeChat(charId, chat) {
  chat.updatedAt = new Date().toISOString();
  const p = path.join(chatsDir(charId), `${path.basename(chat.id)}.json`);
  atomicWrite(p, JSON.stringify(chat, null, 2));
}

export function deleteChat(charId, chatId) {
  const p = path.join(chatsDir(charId), `${path.basename(chatId)}.json`);
  fs.rmSync(p, { force: true });
}

// ---------- 議事會 councils(跨人物,多個 persona 同場) ----------

const COUNCILS_DIR = path.join(DATA_DIR, 'councils');

function councilPath(id) {
  return path.join(COUNCILS_DIR, `${path.basename(String(id))}.json`);
}

export function listCouncils() {
  if (!fs.existsSync(COUNCILS_DIR)) return [];
  const out = [];
  for (const name of fs.readdirSync(COUNCILS_DIR)) {
    if (!name.endsWith('.json')) continue;
    try {
      const c = JSON.parse(fs.readFileSync(path.join(COUNCILS_DIR, name), 'utf8'));
      out.push({
        id: c.id, title: c.title,
        participants: c.participants,
        messageCount: c.messages.length,
        updatedAt: c.updatedAt,
      });
    } catch {
      // 略過損毀檔
    }
  }
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return out;
}

export function createCouncil({ title, participants }) {
  if (!Array.isArray(participants) || participants.length < 2) {
    throw new Error('議事會至少需要 2 位已蒸餾的人物');
  }
  fs.mkdirSync(COUNCILS_DIR, { recursive: true });
  const council = {
    id: `council-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: title || `議事會 ${new Date().toLocaleString('zh-TW')}`,
    participants, // [{ id, name }]
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeCouncil(council);
  return council;
}

export function getCouncil(id) {
  return JSON.parse(fs.readFileSync(councilPath(id), 'utf8'));
}

export function writeCouncil(council) {
  council.updatedAt = new Date().toISOString();
  fs.mkdirSync(COUNCILS_DIR, { recursive: true });
  atomicWrite(councilPath(council.id), JSON.stringify(council, null, 2));
}

export function deleteCouncil(id) {
  fs.rmSync(councilPath(id), { force: true });
}
