// PDF工具：把上游 BentoPDF 寫死、沒走翻譯系統的英文介面文字換成繁體中文（指南第 7 節「繁中介面」）。
// build.mjs 把對照表（i18n/zh-TW.json）嵌進這支程式，放在 /zh-TW/ 與不帶語言的頁面 <head> 的第一個 script（defer，比上游的 module script 先跑）；
// 其他語言、子資料夾（PDF.js 檢視器等）與上游官網頁面（scan.mjs 的 UNLINKED_PAGES）不放。
// 只在介面語言是繁體中文時作用；畫面上的文字節點或屬性「整段」等於對照表的英文才換，部分相同不換。
// 不碰使用者的內容：PDF 文字層、可編輯區、輸入框的值、標了 translate="no" 的區塊都略過。
(function () {
  'use strict';
  var DICT = /*__DICT__*/ null;
  if (!DICT || typeof MutationObserver === 'undefined') return;

  var LANG = 'zh-TW';
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tooltip'];
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
  // PDF.js 的文字層與註解層、可編輯區、明確標示不翻的區塊
  var SKIP_SELECTOR = '.textLayer,.annotationLayer,[contenteditable=""],[contenteditable="true"],[translate="no"],.notranslate';
  var exact = new Map(Object.entries(DICT.strings || {}));
  // [規則運算式, 譯文片段（字串與變數序號混排）, 必含的固定文字]，格式見 i18n/scan.mjs 的 compile()
  var patterns = (DICT.patterns || []).map(function (p) {
    return { re: new RegExp(p[0]), out: p[1], must: p[2] };
  });

  function active() {
    return document.documentElement.lang === LANG || /^\/zh-TW(\/|$)/.test(location.pathname);
  }

  // 前後空白保留，中間的連續空白當成一個空白比對。
  // 對照表也有少數中文 key（上游繁中翻譯裡用「我們」的句子），所以整段比對不限英文；句型只比對含英文的
  function tr(text) {
    if (!text) return null;
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    var core = m[2].replace(/\s+/g, ' ');
    if (!core) return null;
    var hit = exact.get(core);
    if (hit === undefined && core.length < 400 && /[A-Za-z]/.test(core)) {
      for (var i = 0; i < patterns.length; i++) {
        var p = patterns[i];
        if (core.indexOf(p.must) < 0) continue;
        var g = p.re.exec(core);
        if (g) {
          hit = p.out.map(function (x) { return typeof x === 'number' ? g[x + 1] : x; }).join('');
          break;
        }
      }
    }
    return hit === undefined || hit === core ? null : m[1] + hit + m[3];
  }

  function skipped(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentNode) {
      if (SKIP_TAGS[e.tagName]) return true;
    }
    return !!(el && el.closest && el.closest(SKIP_SELECTOR));
  }

  function textNode(n) {
    var parent = n.parentNode;
    if (!parent || (parent.nodeType === 1 && skipped(parent))) return;
    var t = tr(n.data);
    if (t !== null) n.data = t;
  }

  function attrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]);
      if (v) {
        var t = tr(v);
        if (t !== null) el.setAttribute(ATTRS[i], t);
      }
    }
    // <input type="button|submit" value="…"> 的按鈕文字
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && el.value) {
      var tv = tr(el.value);
      if (tv !== null) el.value = tv;
    }
  }

  function walk(root) {
    if (root.nodeType === 3) return textNode(root);
    if (root.nodeType === 1) {
      // 輸入框的內容是使用者的，但 placeholder 等屬性是介面
      if (root.tagName === 'TEXTAREA' && !skipped(root.parentNode)) attrs(root);
      if (skipped(root)) return;
      attrs(root);
      if (root.shadowRoot) shadow(root.shadowRoot);
    } else if (root.nodeType !== 11 && root.nodeType !== 9) {
      return;
    }
    var it = document.createTreeWalker(root, 5 /* SHOW_ELEMENT | SHOW_TEXT */, {
      acceptNode: function (n) {
        if (n.nodeType !== 1) return 1;
        if (n.tagName === 'TEXTAREA' && !n.matches(SKIP_SELECTOR)) attrs(n);
        return SKIP_TAGS[n.tagName] || (n.matches && n.matches(SKIP_SELECTOR)) ? 2 /* REJECT */ : 1;
      },
    });
    for (var n = it.nextNode(); n; n = it.nextNode()) {
      if (n.nodeType === 3) {
        var t = tr(n.data);
        if (t !== null) n.data = t;
      } else {
        attrs(n);
        if (n.shadowRoot) shadow(n.shadowRoot);
      }
    }
  }

  var observed = new WeakSet();
  var observer = new MutationObserver(function (records) {
    if (!active()) return;
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (r.type === 'childList') {
        for (var j = 0; j < r.addedNodes.length; j++) walk(r.addedNodes[j]);
      } else if (r.type === 'characterData') {
        textNode(r.target);
      } else if (r.type === 'attributes') {
        if (r.target === document.documentElement && r.attributeName === 'lang') {
          relang = true;
          try { walk(document.documentElement); } finally { relang = false; }
        }
        else if (!skipped(r.target.tagName === 'TEXTAREA' ? r.target.parentNode : r.target)) attrs(r.target);
      }
    }
  });
  var OPTS = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat(['lang', 'value']) };
  function watch(root) {
    if (observed.has(root)) return;
    observed.add(root);
    observer.observe(root, OPTS);
    if (active()) walk(root);
  }
  // 掃到 shadow DOM 的宿主時：還沒監看的開始監看；已經在監看的只在語言剛切成繁中時重翻一次
  // （不帶語言的網址一開始是英文，等上游的翻譯系統載入才切換，切換前畫好的 shadow DOM 要補翻；其他時候監看已經涵蓋）
  var relang = false;
  function shadow(root) {
    if (!observed.has(root)) watch(root);
    else if (relang) walk(root);
  }

  // 工作流程建構器等元件把畫面放在 shadow DOM 裡，攔下 attachShadow 一起監看（只有 open 的拿得到）
  var attach = Element.prototype.attachShadow;
  if (attach) {
    Element.prototype.attachShadow = function () {
      var root = attach.apply(this, arguments);
      try { if (root) watch(root); } catch (e) { /* 翻譯失敗不影響功能 */ }
      return root;
    };
  }

  // 瀏覽器內建的提示框（alert／confirm／prompt）
  ['alert', 'confirm', 'prompt'].forEach(function (name) {
    var orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function (message) {
      var args = Array.prototype.slice.call(arguments);
      if (active() && typeof message === 'string') {
        var t = tr(message);
        if (t !== null) args[0] = t;
      }
      return orig.apply(window, args);
    };
  });

  watch(document.documentElement);
})();
