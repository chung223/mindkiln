import * as OpenCC from 'opencc-js';
import { readConfig } from './store.js';

// OpenCC 簡→繁轉換。變體:
//   'twp' 台灣正體 + 台灣詞彙(軟件→軟體、鼠標→滑鼠)—— 適合台灣 UI,但會「台灣化」對方用詞
//   'tw'  台灣正體,只轉字不改詞 —— 想保留對方原本語感(如大陸講者說「打印/内存」)時用
//   'hk'  香港繁體
export const ZH_VARIANTS = ['twp', 'tw', 'hk'];
export const DEFAULT_VARIANT = 'twp';

const _converters = {};
function converter(variant) {
  const v = ZH_VARIANTS.includes(variant) ? variant : DEFAULT_VARIANT;
  if (!_converters[v]) _converters[v] = OpenCC.Converter({ from: 'cn', to: v });
  return _converters[v];
}

function getVariant() {
  return readConfig().zhVariant || DEFAULT_VARIANT;
}

// 略過程式碼:圍籬 ```...``` 與行內 `...` 原樣保留,只轉換散文部分,
// 避免把 print("信息") 轉成 print("資訊")、把變數/技術詞改掉。
// 行內碼要求首尾緊貼反引號(非空白),避免把「散落的一對反引號中間夾的散文」誤判為程式碼而不轉。
const CODE_SPLIT = /(```[\s\S]*?```|`[^`\n\s](?:[^`\n]*[^`\n\s])?`)/g;

export function toTraditional(text, variant = getVariant()) {
  if (!text) return text;
  const conv = converter(variant);
  return text
    .split(CODE_SPLIT)
    .map((seg) => (seg.startsWith('`') ? seg : conv(seg)))
    .join('');
}

// 是否對「這個人物」的輸出強制繁體:全域開關開啟 且 此人物輸出語言為繁中。
// 輸出語言為簡中 / 英日 / match-corpus 時不轉(以免竄改非繁中內容)。
export function shouldForceTraditional(character) {
  const cfg = readConfig();
  if (cfg.forceTraditional === false) return false;
  const lang = character?.outputLanguage || 'zh-Hant';
  return lang === 'zh-Hant';
}

// 串流用的邊界緩衝轉換器:累積 delta,遇到標點/換行/空白等邊界才把該段轉換後送出。
// 中文詞彙不跨標點,故以邊界切段可保證「逐段轉換的串接 == 整段轉換」,不會切斷台灣詞彙轉換。
const BOUNDARY = /[。！？!?；;，,、：:（）()「」『』【】\s]/;

export function makeStreamConverter(emit, variant = getVariant()) {
  let buf = '';
  return {
    push(delta) {
      buf += delta;
      let cut = -1;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (BOUNDARY.test(buf[i])) { cut = i + 1; break; }
      }
      if (cut > 0) {
        const head = buf.slice(0, cut);
        buf = buf.slice(cut);
        emit(toTraditional(head, variant));
      }
    },
    flush() {
      if (buf) {
        emit(toTraditional(buf, variant));
        buf = '';
      }
    },
  };
}
