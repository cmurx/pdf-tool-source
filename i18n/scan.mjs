// PDF工具：找出上游寫死、沒走翻譯系統的英文介面文字（候選字串），對照 i18n/zh-TW.json 看還缺哪些。
// 由 build.mjs 呼叫：建置結束時印出缺幾條（只提醒不擋）；node build.mjs i18n-scan 把缺的寫成檔案，翻好再併進對照表。
//
// 來源：建置輸出的英文頁面（根目錄的 *.html，已展開共用片段），以及上游 src/js 的 .ts／.js 字串常值。
// 用上游已安裝的 jsdom 與 typescript 解析（npm ci 時核對過完整性雜湊）。
// 這是粗篩：會混進類別名稱、內部訊息等雜訊，翻譯時放進對照表的 ignore 就不會再列出來。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tooltip'];
// SIMPLE_MODE 沒有連到的上游官網頁面（授權條款、隱私權、聯絡、行銷頁）：不翻。
// 法律文字由 AI 翻譯可能改變意思，而且內容是 BentoPDF 官網自己的，不是這個網站的
export const UNLINKED_PAGES = ['about.html', 'contact.html', 'faq.html', 'licensing.html', 'privacy.html', 'terms.html', 'pdf-converter.html', 'pdf-merge-split.html', 'pdf-security.html'];
// 這些函式的字串參數是程式內部用的（選擇器、事件、翻譯鍵、紀錄），不是介面文字
const INTERNAL_CALLS = /^(console\.\w+|querySelector(All)?|getElementById|getElementsByClassName|closest|matches|addEventListener|removeEventListener|createElement|createElementNS|setAttribute|getAttribute|removeAttribute|hasAttribute|toggleAttribute|classList\.\w+|t|translate|i18next\.t|translateOrFallback|import|require|postMessage|getStoredItem|setStoredItem|localStorage\.\w+|sessionStorage\.\w+|fetch|dispatchEvent|CustomEvent|Event|RegExp|setProperty|getPropertyValue|replace|replaceAll|split|includes|startsWith|endsWith|indexOf|test|match|join)$/;

export function scan(src, assetsDir) {
  const req = createRequire(join(src, 'package.json'));
  const ts = req('typescript');
  const { JSDOM } = req('jsdom');
  const strings = new Map();
  const patterns = new Map();
  const add = (map, s, where) => {
    if (!map.has(s)) map.set(s, new Set());
    map.get(s).add(where);
  };

  // --- 頁面 ---
  for (const f of readdirSync(assetsDir).filter((f) => f.endsWith('.html') && !UNLINKED_PAGES.includes(f))) {
    const doc = new JSDOM(readFileSync(join(assetsDir, f), 'utf8')).window.document;
    const walker = doc.createTreeWalker(doc.documentElement, 5);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) {
        if (n.parentElement?.closest('script,style,svg,noscript,template,textarea,code,pre,[data-i18n],head')) continue;
        const s = norm(n.data);
        if (looksLikeText(s)) add(strings, s, f);
      } else {
        for (const a of ATTRS) {
          const v = n.getAttribute(a);
          if (v && !n.hasAttribute(`data-i18n-${a}`) && !n.closest('head')) {
            const s = norm(v);
            if (looksLikeText(s)) add(strings, s, `${f} @${a}`);
          }
        }
        if (n.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(n.getAttribute('type') || '') && n.getAttribute('value')) {
          const s = norm(n.getAttribute('value'));
          if (looksLikeText(s)) add(strings, s, `${f} @value`);
        }
      }
    }
  }

  // --- 程式 ---
  for (const file of listCode(join(src, 'src', 'js'))) {
    const rel = relative(src, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
    const visit = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        if (!internal(ts, node)) collect(node.text, [], rel);
      } else if (ts.isTemplateExpression(node)) {
        if (!internal(ts, node)) {
          // ${…} 換成 {0}、{1}…，之後翻成規則（patterns）
          let s = node.head.text;
          node.templateSpans.forEach((span, i) => { s += `\u0000${i}\u0000${span.literal.text}`; });
          collect(s, node.templateSpans.map((_, i) => i), rel);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  function collect(raw, holes, where) {
    // 字串裡帶 HTML 時，拆成標籤之間的文字，另外取出介面屬性
    const parts = [];
    if (/<[a-zA-Z/!]/.test(raw)) {
      const noScript = raw.replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, '');
      for (const m of noScript.matchAll(/(?:placeholder|title|aria-label|alt|data-tooltip)="([^"]*)"/g)) parts.push(m[1]);
      for (const seg of noScript.replace(/<[^>]*>/g, '\u0001').split('\u0001')) parts.push(seg);
    } else {
      parts.push(raw);
    }
    for (const p of parts) {
      const s = norm(p.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'));
      if (!s.includes('\u0000')) {
        if (looksLikeText(s)) add(strings, s, where);
        continue;
      }
      let idx = 0;
      const tpl = s.replace(/\u0000\d+\u0000/g, () => `{${idx++}}`);
      const literal = tpl.replace(/\{\d+\}/g, ' ').trim();
      // 句型的固定文字要求三個以上連續字母（比 looksLikeText 的兩個嚴）：「{0}x{1}」這類尺寸、座標不是句子
      if (/[A-Za-z]{3}/.test(literal) && looksLikeText(literal)) add(patterns, tpl, where);
    }
  }

  return { strings, patterns };
}

// 字串候選：有兩個以上連續字母、不像識別字／類別名稱／網址／路徑（句型另外要求三個，見 collect）
function looksLikeText(s) {
  if (!s || s.length > 500 || !/[A-Za-z]{2}/.test(s)) return false;
  if (/^(https?:|data:|blob:|\/|\.\/|#|\.|@|--)/.test(s)) return false;
  if (/^[\w$.-]+\.(js|mjs|ts|css|json|wasm|pdf|png|svg|html|woff2?|ttf|otf)$/i.test(s)) return false;
  if (!/\s/.test(s)) {
    // 單一個字：要像介面上的單字（Download、OK），不像程式識別字（camelCase、snake_case、kebab-case）
    if (/[_$]|[a-z][A-Z]|-|\d/.test(s)) return false;
    return /^[A-Z][a-z]+[.!?:…]*$|^[A-Z]{2,5}$/.test(s);
  }
  // 多個字：每個詞都像 CSS 類別（含 - : [ ] /）就不是
  const tokens = s.split(/\s+/);
  if (tokens.every((t) => /^[!-]?[a-z0-9]+([:\-/[\].%#][a-z0-9[\].%#/-]*)*$/.test(t)) && tokens.some((t) => /[-:[\]/]/.test(t))) return false;
  if (tokens.every((t) => /^[a-z][a-zA-Z0-9]*$/.test(t)) && !/^[a-z]+( [a-z]+)+$/.test(s)) return false;
  return true;
}

function internal(ts, node) {
  let p = node.parent;
  // 物件的鍵、比較運算、switch case、型別都不是介面文字
  if (ts.isPropertyAssignment(p) && p.name === node) return true;
  if (ts.isElementAccessExpression(p) || ts.isLiteralTypeNode(p) || ts.isCaseClause(p)) return true;
  if (ts.isBinaryExpression(p) && /^(===|!==|==|!=|in|instanceof)$/.test(p.operatorToken.getText())) return true;
  if (ts.isTaggedTemplateExpression(p) && /css$/.test(p.tag.getText())) return true;
  if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
    const callee = p.expression.getText().replace(/\s+/g, '').replace(/^(this|window|document|\w+)\??\./, (m) => (/^(window|document|this)\.$/.test(m) ? '' : m));
    const tail = callee.split('.').slice(-2).join('.');
    if (INTERNAL_CALLS.test(callee) || INTERNAL_CALLS.test(tail) || INTERNAL_CALLS.test(callee.split('.').pop())) return true;
  }
  return false;
}

function norm(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function listCode(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...listCode(p));
    else if (/\.(ts|js|mjs)$/.test(e) && !/\.d\.ts$|\.test\.ts$/.test(e)) out.push(p);
  }
  return out;
}

// 對照表還沒涵蓋的候選（strings、templates、ignore 都算涵蓋）
export function missing(found, dict) {
  const covered = new Set([...Object.keys(dict.strings || {}), ...Object.keys(dict.templates || {}), ...(dict.ignore || [])]);
  const pick = (map) => [...map].filter(([s]) => !covered.has(s)).map(([s, w]) => ({ en: s, where: [...w].slice(0, 3) }));
  return { strings: pick(found.strings), templates: pick(found.patterns) };
}

// 每個變數依它在句子裡的位置決定接受什麼（2026-10-17 第二輪 /code-review 後，取代原本「整句字母數」的判斷）：
// - 緊接在英文字母後面（page{1}、file{1}）：英文的複數字尾，只接受 s／es 或空字串
// - 有分隔符號圍住或引出（"{0}"、({0})、[{0}]、Error: {0}、→ {1}、= {0}）：明顯是放值的位置，接受任意文字
// - 其他（Upload {0}、Layer {0}、句首的 {0}）：只接受數字（可帶負號、單位）。
//   這種位置接受任意文字的話，檔名、書籤、圖層名稱等使用者內容剛好長得像句型就會被改掉
const PLURAL_SLOT = '((?:e?s)?)';
const TEXT_SLOT = '(.+?)';
const NUMBER_SLOT = '(-?\\d[\\d,.]*(?:\\s?[A-Za-z%°]{1,3})?)';
const OPEN = /(["'“「(（[]|[:：→=]\s*)$/;
const CLOSE = /^["'”」)）\]]/;

function slotKind(before, after) {
  if (/[A-Za-z]$/.test(before) && !/^[A-Za-z]/.test(after)) return PLURAL_SLOT;
  const open = OPEN.exec(before);
  if (open) {
    // 引號、括號要前後成對；冒號、箭頭、等號後面的值要放在句尾或接標點
    if (/[:：→=]/.test(open[1])) return /^(\s*$|[\s.,;!?…)）]|\.\.\.)/.test(after) ? TEXT_SLOT : NUMBER_SLOT;
    return CLOSE.test(after) ? TEXT_SLOT : NUMBER_SLOT;
  }
  return NUMBER_SLOT;
}

// 對照表 → 執行時用的格式：[規則運算式, 譯文片段, 必含的固定文字]。
// 譯文片段是字串與變數序號混排的陣列，執行時直接組字（不用 $1 這類取代寫法，譯文裡的 $ 與第 10 個以上的變數都不會出錯）。
// 必含的固定文字是最長的一段原文，執行時先用 indexOf 篩掉不可能對上的，才跑規則運算式
export function compile(dict) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const literal = (en) => en.split(/\{\d+\}/);
  const patterns = Object.entries(dict.templates || {})
    .sort((a, b) => literal(b[0]).join('').length - literal(a[0]).join('').length)
    .map(([en, zh]) => {
      const order = [];
      const parts = en.split(/(\{\d+\})/);
      const src = '^' + parts.map((part, i) => {
        const m = /^\{(\d+)\}$/.exec(part);
        if (!m) return esc(part);
        order.push(Number(m[1]));
        return slotKind(parts[i - 1] || '', parts[i + 1] || '');
      }).join('') + '$';
      const out = zh.split(/(\{\d+\})/).filter((p) => p !== '').map((part) => {
        const m = /^\{(\d+)\}$/.exec(part);
        if (!m) return part;
        const i = order.indexOf(Number(m[1]));
        if (i < 0) throw new Error(`對照表 templates「${en}」的譯文用了原文沒有的 {${m[1]}}`);
        return i;
      });
      const must = literal(en).sort((a, b) => b.length - a.length)[0];
      return [src, out, must];
    });
  return { strings: dict.strings || {}, patterns };
}
