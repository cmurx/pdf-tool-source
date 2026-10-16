# PDF工具的上游補丁

`build.mjs` 每次建置時，先把上游 BentoPDF 還原成 `upstream.json` 記的版本，再依檔名順序 `git apply` 這裡的 `*.patch`。套不上建置就停下來：上游可能已經修好（確認後刪掉補丁），或改了寫法（重做補丁）。

**依 AGPL-3.0，這裡的補丁要公開**，讓網站使用者取得修改後的原始碼：公開位置寫在 `build.mjs` 的 `SOURCE_URL`，每個工具頁的頁尾都會顯示。新增或修改補丁時，同一次更新公開位置的內容。

每個補丁的目標都是送回上游；上游合併、`upstream.json` 更新到含修正的版本後，刪掉補丁。

## 0001-libreoffice-cjk-fonts.patch：Office 轉 PDF 的中文變方框

- **問題**：上游內附的 LibreOffice WASM（`soffice.data`）只有 137 個西文、阿拉伯文、希伯來文等字型，沒有中日韓字型；Word／Excel／PowerPoint 轉 PDF 時中文全部變成方框。
- **補丁**：`src/js/utils/libreoffice-loader.ts` 讀新的建置設定 `VITE_LIBREOFFICE_FONT_URLS`（逗號分隔的字型網址），載入後用 `@matbee/libreoffice-converter` 的 `fonts` 選項注入 LibreOffice；`src/types/globals.d.ts`、`.env.example` 跟著加。
- **另外一步（不在補丁裡）**：上游 `public/libreoffice-wasm/browser.worker.global.js` 是不支援 `fonts` 的舊版，`build.mjs` 的 `syncLibreOfficeWorker()` 換成 `node_modules/@matbee/libreoffice-converter`（2.6.0）的版本。這個檔是壓縮過的第三方程式，不適合做成文字補丁。
- **驗證**（2026-10-16）：指定思源黑體、新細明體、標楷體、微軟正黑體的 Word 檔，以及沒指定字型的 Word 檔，轉出來的中文都正常（沒有的字型會改用思源黑體）。
- **上游狀態**：還沒送（2026-10-16 查 issues 沒有人回報過）。系統負責人決定用個人 GitHub 帳號 fork 上游、送 PR。上游要求第一次送 PR 時簽貢獻者授權書（ICLA，CLA 機器人會在 PR 留言），內容包含允許上游把貢獻用在商業授權版本；代表雇主貢獻的要改簽 CCLA。PR 要以上游的 `main` 為基礎，送之前確認補丁還套得上。

### 送上游的說明（草稿）

> **Title:** Office to PDF: CJK text renders as boxes (allow injecting extra fonts into LibreOffice)
>
> Converting Word/Excel/PowerPoint files that contain Chinese, Japanese or Korean text produces PDFs where every CJK character is a box (tofu). The bundled `soffice.data` ships 137 fonts but no CJK font, and LibreOffice has nothing to fall back to.
>
> `@matbee/libreoffice-converter` already supports injecting fonts via the `fonts` option, but:
> 1. `public/libreoffice-wasm/browser.worker.global.js` is an older build that ignores `fonts` (it has no code that writes to `/instdir/share/fonts/`). Replacing it with `node_modules/@matbee/libreoffice-converter/dist/browser.worker.global.js` (2.6.0) fixes that.
> 2. `libreoffice-loader.ts` never passes `fonts`.
>
> This PR adds an optional build-time variable `VITE_LIBREOFFICE_FONT_URLS` (comma-separated URLs). The fonts are fetched alongside `soffice.wasm`/`soffice.data` and passed to `WorkerBrowserConverter`; a failed font fetch only logs a warning. Self-hosters can point it at the Noto Sans CJK font they already serve for OCR, e.g. `VITE_LIBREOFFICE_FONT_URLS=/wasm/ocr/fonts/NotoSansCJKtc-Regular.otf`.
>
> Tested with .docx files using Noto Sans CJK TC, PMingLiU, DFKai-SB and Microsoft JhengHei (the missing ones fall back to the injected font) and with a file that specifies no East Asian font.
