import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slugify, normalizeAliases, characterDir } from '../server/store.js';
import { toTraditional, makeStreamConverter } from '../server/zhtw.js';
import { looksLikeChatExport, normalizeChatExport, detectSpeakers } from '../server/extract.js';
import { languageDirective, distillSharedSystem } from '../server/prompts.js';

// ---------- store: slug / aliases / 路徑守衛 ----------

test('slugify handles CJK, punctuation, empties', () => {
  assert.equal(slugify('賈伯斯'), '賈伯斯');
  assert.equal(slugify('  Steve Jobs!  '), 'steve-jobs');
  assert.equal(slugify('@@@'), 'character');
});

test('normalizeAliases splits on comma / 頓號 / newline and trims', () => {
  assert.deepEqual(normalizeAliases('阿明, 王大明\n@ming、小明'), ['阿明', '王大明', '@ming', '小明']);
  assert.deepEqual(normalizeAliases(['  a ', '', 'b']), ['a', 'b']);
  assert.deepEqual(normalizeAliases(null), []);
});

test('characterDir rejects path traversal and dot ids', () => {
  for (const bad of ['.', '..', '', '../..', 'foo/../..']) {
    assert.throws(() => characterDir(bad), /invalid character id/);
  }
  // 正常 id 應可解析且落在 characters 目錄下
  assert.ok(characterDir('valid-name').endsWith('valid-name'));
});

// ---------- zhtw: 轉換 / 變體 / 略過程式碼 / 串流不變性 ----------

test('toTraditional twp converts characters AND Taiwan vocabulary', () => {
  assert.equal(toTraditional('软件和鼠标的信息', 'twp'), '軟體和滑鼠的資訊');
});

test('toTraditional tw converts characters only, keeps vocabulary', () => {
  // 打印/内存 用字轉繁但詞彙不台灣化
  assert.equal(toTraditional('打印内存', 'tw'), '打印內存');
});

test('toTraditional skips fenced and inline code', () => {
  const src = '把 `软件` 印出:\n```\nprint("信息")\n```\n說明';
  const out = toTraditional(src, 'twp');
  assert.ok(out.includes('`软件`'), 'inline code preserved');
  assert.ok(out.includes('print("信息")'), 'fenced code preserved');
});

test('toTraditional leaves already-Traditional text unchanged', () => {
  const t = '滑鼠和軟體的資訊';
  assert.equal(toTraditional(t, 'twp'), t);
});

test('makeStreamConverter: concatenated chunk conversion == whole-text conversion', () => {
  const tokens = ['鼠', '标', '和', '软', '件', '的', '信', '息', '。', '很', '重', '要'];
  let out = '';
  const conv = makeStreamConverter((c) => (out += c), 'twp');
  for (const t of tokens) conv.push(t);
  conv.flush();
  assert.equal(out, toTraditional(tokens.join(''), 'twp'));
});

// ---------- extract: 聊天匯出偵測 / 清洗 / 發言者 ----------

const WHATSAPP = [
  '[2023/5/1, 14:03:22] 阿明: 第一性原理很重要',
  '[2023/5/1, 14:04:01] 小華: 為什麼?',
  '[2023/5/1, 14:04:30] 阿明: 因為能從根本推理',
  '[2023/5/1, 14:05:00] 小華: <Media omitted>',
  'Messages and calls are end-to-end encrypted.',
].join('\n');

test('looksLikeChatExport detects WhatsApp export', () => {
  assert.equal(looksLikeChatExport(WHATSAPP), true);
  assert.equal(looksLikeChatExport('這是一段普通的文章。\n沒有時間戳。'), false);
});

test('normalizeChatExport strips clock times + noise, keeps date anchors', () => {
  const out = normalizeChatExport(WHATSAPP);
  assert.ok(out.includes('阿明: 第一性原理很重要'));
  assert.ok(!out.includes('end-to-end encrypted'), 'system line dropped');
  assert.ok(!out.includes('Media omitted'), 'media placeholder dropped');
  assert.ok(!/\d{1,2}:\d{2}/.test(out), 'per-message clock times removed');
  assert.ok(out.includes('—— 2023/5/1 ——'), 'date anchor preserved for timeline');
  assert.equal((out.match(/—— 2023\/5\/1 ——/g) || []).length, 1, 'one divider per date, not per message');
});

test('normalizeChatExport handles Chinese-meridiem iOS export + date changes', () => {
  const ios = [
    '‎[2026/2/24 晚上9:44:29] 小美: 剛到職約兩週',
    '[2026/2/24 晚上9:45:01] 阿明: 辛苦了',
    '[2026/3/25 凌晨12:25:20] 小美: 今天好累',
  ].join('\n');
  assert.equal(looksLikeChatExport(ios + '\n' + ios), true, 'detected despite 晚上/凌晨');
  const out = normalizeChatExport(ios);
  assert.ok(out.includes('小美: 剛到職約兩週'));
  assert.ok(out.includes('—— 2026/2/24 ——'), 'first date anchor');
  assert.ok(out.includes('—— 2026/3/25 ——'), 'second date anchor kept (2026 not lost)');
});

test('detectSpeakers tallies speaker frequencies', () => {
  const s = detectSpeakers(WHATSAPP);
  const byName = Object.fromEntries(s.map((x) => [x.name, x.count]));
  assert.equal(byName['阿明'], 2);
  assert.equal(byName['小華'], 2);
});

// ---------- prompts: 語言指令 / 共享前綴穩定性 ----------

test('languageDirective maps each output language', () => {
  assert.match(languageDirective('zh-Hant'), /繁體/);
  assert.match(languageDirective('zh-Hans'), /簡體/);
  assert.match(languageDirective('en'), /English/);
  assert.match(languageDirective('ja'), /日本語/);
  assert.match(languageDirective('match-corpus'), /語料/);
});

test('distillSharedSystem is byte-identical for the same character inputs (cacheable prefix)', () => {
  const a = distillSharedSystem('費曼', '物理學家', ['費曼'], 'zh-Hant');
  const b = distillSharedSystem('費曼', '物理學家', ['費曼'], 'zh-Hant');
  assert.equal(a, b);
});
