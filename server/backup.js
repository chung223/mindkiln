import { spawn } from 'child_process';
import path from 'path';
import { DATA_DIR } from './store.js';

// 把整個資料夾打包成 tar.gz 直接串流給下載端(用系統 tar,免額外依賴)。
// 以 DATA_DIR 的實際位置為準(可能被 NUWA_DATA_DIR 移到 repo 外)。
export function createBackup(res) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="nuwa-backup-${stamp}.tar.gz"`);
  const tar = spawn('tar', ['-czf', '-', '-C', path.dirname(DATA_DIR), path.basename(DATA_DIR)], { stdio: ['ignore', 'pipe', 'ignore'] });
  tar.stdout.pipe(res);
  tar.on('error', () => {
    if (!res.headersSent) {
      // 尚未送出 body:改回一個真正可見的 JSON 錯誤(不是被誤標成 gzip 的檔案)
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Disposition');
      res.status(500).json({ error: '備份失敗:找不到 tar 指令' });
    } else {
      res.destroy(); // 已在串流中:中斷連線讓下載端看到損毀而非誤以為完整
    }
  });
  tar.on('exit', (code) => {
    // tar 非零離開代表備份不完整;若已在串流中,中斷連線避免交付半截檔案
    if (code !== 0 && !res.writableEnded) {
      if (!res.headersSent) {
        res.removeHeader('Content-Type');
        res.removeHeader('Content-Disposition');
        res.status(500).json({ error: '備份失敗(tar 非正常結束)' });
      } else {
        res.destroy();
      }
    }
  });
  res.on('close', () => {
    if (tar.exitCode === null) tar.kill();
  });
}
