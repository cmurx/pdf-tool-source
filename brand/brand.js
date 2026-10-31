// PDF工具：CMURx 品牌與首頁的快速操作引導（指南第 1.2 節 A、第 8 節）。build.mjs 放進每個最上層的頁面（defer）。
// - 導覽列的網站名稱下面加小字「CMURx」；右邊顯示目前登入的帳號與「登出」；從工作台進來的工作台使用者，最左邊多一個回工作台的 ☰
// - 首頁（有 #tools-header）在搜尋框下面加「第一次用 PDF 工具箱？」：只在繁體中文介面顯示，按關閉後這台裝置不再顯示
// 圖示照共用前端規範用 Lucide（0.469.0 的 lightbulb、x、user、log-out、menu、house、file-text、external-link），行內 SVG。
(function () {
  'use strict';
  var HIDE_KEY = 'cmurx_guide_hidden';

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    (children || []).forEach(function (c) { e.append(c); });
    return e;
  }

  function icon(paths) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  // 介面語言：網址的語言前綴，沒有就看上游記的設定，都沒有是預設的繁中
  function uiLang() {
    var m = /^\/([a-z]{2}(?:-[A-Z]{2})?)(?:\/|$)/.exec(location.pathname);
    if (m) return m[1];
    try { return localStorage.getItem('i18nextLng') || 'zh-TW'; } catch (e) { return 'zh-TW'; }
  }

  // 工具頁的導覽列有 #nav-brand；首頁的導覽列是另一份，沒有 id，找圖示旁邊的名稱
  function brandSub() {
    var brand = document.getElementById('nav-brand') || document.querySelector('nav[data-simple-nav] img + span');
    if (!brand || brand.querySelector('.cmurx-brand-sub')) return;
    brand.classList.add('cmurx-brand');
    brand.appendChild(el('span', { class: 'cmurx-brand-sub' }, ['CMURx']));
  }

  function guide() {
    var header = document.getElementById('tools-header');
    if (!header || document.getElementById('cmurx-guide') || uiLang() !== 'zh-TW') return;
    try { if (localStorage.getItem(HIDE_KEY) === '1') return; } catch (e) { /* 讀不到就照常顯示 */ }
    var prefix = /^\/zh-TW(\/|$)/.test(location.pathname) ? '/zh-TW' : '';
    var link = function (href, text) { return el('a', { href: prefix + href }, [text]); };
    var close = el('button', { type: 'button', class: 'cmurx-guide-close', 'aria-label': '不再顯示這段說明' }, [icon(['M18 6 6 18', 'm6 6 12 12'])]);
    var box = el('section', { id: 'cmurx-guide', class: 'cmurx-guide', 'aria-labelledby': 'cmurx-guide-title' }, [
      icon(['M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5', 'M9 18h6', 'M10 22h4']),
      el('div', {}, [
        el('h2', { id: 'cmurx-guide-title' }, ['第一次用 PDF 工具箱？']),
        el('ul', {}, [
          el('li', {}, ['調整頁面順序、刪除、旋轉、合併：', link('/pdf-multi-tool.html', 'PDF 多功能工具')]),
          el('li', {}, ['註解、螢光標記、塗黑、簽名：', link('/edit-pdf.html', 'PDF 編輯器')]),
          el('li', {}, ['轉檔、壓縮、加密等其他功能：在上面的搜尋框輸入「Word」「壓縮」這類關鍵字']),
          el('li', {}, ['檔案只在你的瀏覽器裡處理，不會上傳。']),
        ]),
      ]),
      close,
    ]);
    close.addEventListener('click', function () {
      try { localStorage.setItem(HIDE_KEY, '1'); } catch (e) { /* 存不了就只關這次 */ }
      box.remove();
      var search = document.getElementById('search-bar');
      if (search) search.focus();
    });
    // 放在搜尋框下面（說明裡寫「上面的搜尋框」）；找不到搜尋框就放在標題下面
    var search = document.getElementById('search-bar');
    var anchor = (search && (search.closest('.mb-8') || search.parentElement)) || header;
    anchor.after(box);
  }

  // 導覽列最左邊的 ☰：從工作台進來的工作台使用者才有（/auth/me 的 desk；設計方案/PDF單一登入_規格.md 第 5 節）。
  // 項目是靜態連結，不問工作台（跨站 fetch 會碰到 CSP 與第三方 cookie），所以沒有待辦數、表單承辦、後台。
  // 工作台是別的網站：開新分頁（同工作台選單的規則），PDF 這一頁正在處理的檔案不會不見。連結寫完整網址（理由見下面登出的註解）。
  // 不放「PDF 工具箱」：回本站首頁用左上角的標誌；放了要判斷首頁與語言前綴（第二輪 /code-review 第 5、6 項，2026-10-31 拿掉）
  function deskMenu(row) {
    if (document.getElementById('cmurx-desk-menu')) return;
    var ext = function () { return el('span', { class: 'cmurx-desk-ext' }, [icon(['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'])]); };
    var item = function (href, label, paths) {
      return el('li', {}, [el('a', { href: href, target: '_blank', rel: 'noopener', 'aria-label': label + '（開新分頁）' },
        [icon(paths), el('span', {}, [label]), ext()])]);
    };
    var panel = el('ul', { id: 'cmurx-desk-menu', class: 'cmurx-desk-menu', hidden: '' }, [
      item('https://desk.cmu.tw/', '工作台首頁', ['M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8', 'M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z']),
      item('https://desk.cmu.tw/reports', '報告', ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z', 'M14 2v4a2 2 0 0 0 2 2h4', 'M10 9H8', 'M16 13H8', 'M16 17H8']),
    ]);
    var btn = el('button', { type: 'button', class: 'cmurx-desk-btn', 'aria-expanded': 'false', 'aria-controls': 'cmurx-desk-menu', 'aria-label': '工作台選單' },
      [icon(['M4 6h16', 'M4 12h16', 'M4 18h16'])]);
    var wrap = el('div', { class: 'cmurx-desk' }, [btn, panel]);
    function setOpen(open) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.hidden = !open;
    }
    btn.addEventListener('click', function () { setOpen(panel.hidden); });
    document.addEventListener('click', function (e) { if (!panel.hidden && !wrap.contains(e.target)) setOpen(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !panel.hidden) { setOpen(false); btn.focus(); }
    });
    // 點了開新分頁的項目：這一頁收起選單
    panel.addEventListener('click', function (e) { if (e.target.closest('a[target="_blank"]')) setOpen(false); });
    row.prepend(wrap);
  }

  // 導覽列右邊：目前登入的帳號＋登出（帳號向 /auth/me 問；cookie 是 HttpOnly，網頁讀不到）
  function account() {
    var row = document.querySelector('nav[data-simple-nav] .h-16');
    if (!row || document.getElementById('cmurx-account')) return;
    var box = el('div', { id: 'cmurx-account', class: 'cmurx-account' });
    row.appendChild(box);
    fetch('/auth/me', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.email) return;
        if (data.desk === true) deskMenu(row);
        box.append(
          el('span', { class: 'cmurx-account-email', title: data.email }, [
            icon(['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z']),
            el('span', { class: 'visually-hidden' }, ['目前登入：']),
            el('span', { class: 'cmurx-account-text' }, [data.email]),
          ]),
          // 寫完整網址：上游的 rewriteLinks() 會把 / 開頭的連結加上語言前綴（/zh-TW/auth/logout 就找不到了），完整網址它不動
          el('a', { class: 'cmurx-account-logout', href: location.origin + '/auth/logout' }, [icon(['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9']), '登出']),
        );
      })
      .catch(function () { /* 拿不到就不顯示，不影響使用 */ });
  }

  function run() {
    brandSub();
    account();
    guide();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
