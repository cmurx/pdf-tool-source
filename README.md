# PDF 工具箱（pdf.cmu.tw）的修改原始碼

[pdf.cmu.tw](https://pdf.cmu.tw) 是以 [BentoPDF](https://github.com/alam00000/bentopdf)（AGPL-3.0）建置的 PDF 工具網站，檔案全程在使用者的瀏覽器裡處理、不上傳。依 AGPL-3.0 第 13 條，這裡公開網站所用的修改版原始碼。

## 網站跑的是什麼

上游 BentoPDF [v2.8.8](https://github.com/alam00000/bentopdf/tree/f96cd4e5166f3d51393dfe9f3c440b5bb77802f1)（commit `f96cd4e5166f3d51393dfe9f3c440b5bb77802f1`），加上：

1. [`patches/`](patches/) 的補丁（說明見 [patches/README.md](patches/README.md)）。
2. 把上游 `public/libreoffice-wasm/browser.worker.global.js` 換成 `node_modules/@matbee/libreoffice-converter/dist/browser.worker.global.js`（上游內附的舊版不支援注入字型）。
3. [`build.mjs`](build.mjs) 開頭 `BUILD_ENV` 的建置設定（品牌名稱、預設語言、WASM 與字型改從同網域提供），以及 [`security-headers.json`](security-headers.json) 產生的安全標頭。
4. [`i18n/`](i18n/)：上游寫死、沒走翻譯系統的英文介面換成繁體中文。`build.mjs` 把對照表 `zh-TW.json` 嵌進 `translate.js`，放在每個頁面 `<head>` 的第一個 script；介面語言是繁體中文時，畫面文字整段等於對照表的英文才換。`scan.mjs` 找出還沒翻的英文。

## 重現

需要 Node.js 22 以上與 git：

```sh
node build.mjs
```

`build.mjs` 會抓上游指定的版本、核對 commit 雜湊、套補丁、建置，並下載 WASM 與字型（npm 以外的下載核對 [`assets-lock.json`](assets-lock.json) 的 SHA-256）。輸出在工作資料夾的 `out/assets`（超過 25 MiB 的檔在 `out/r2`）。`worker/` 是網站的部署設定（不是 BentoPDF 的衍生作品），不在這個 repo：沒有它時 `build.mjs` 會略過部署設定的核對，建置照常；`dev` 指令需要它。

## 授權

AGPL-3.0，見 [LICENSE](LICENSE)。BentoPDF 的著作權屬於其作者。

---

# Modified source of PDF 工具箱 (pdf.cmu.tw)

[pdf.cmu.tw](https://pdf.cmu.tw) runs [BentoPDF](https://github.com/alam00000/bentopdf) (AGPL-3.0); all processing happens in the browser. As required by AGPL-3.0 section 13, this repository provides the modified source: upstream v2.8.8 (`f96cd4e5166f3d51393dfe9f3c440b5bb77802f1`) + the patches in [`patches/`](patches/) + the LibreOffice worker swap described above, built with `node build.mjs`.
