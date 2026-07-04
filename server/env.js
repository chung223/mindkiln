import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 極簡 .env 載入器(無相依套件)。必須在其他模組讀取 process.env 之前執行,
// 因此在 index.js 的最上方第一個 import 它。真實環境變數優先於 .env(只補未設定的)。
const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
try {
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch {
  // 沒有 .env 檔就用預設,不報錯
}
