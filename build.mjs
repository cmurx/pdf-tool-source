// PDF工具：從上游 BentoPDF 的指定版本建置 pdf.cmu.tw 要部署的檔案。
// 上游程式碼只透過 patches/ 的補丁修改，補丁必須公開（AGPL-3.0，見 專案開發指南.md 第 6 節）。
//
// 用法（在 PDF工具/ 執行）：
//   node build.mjs                建置。上游原始碼與輸出都放在 OneDrive 外面的工作資料夾
//   node build.mjs --update-lock  外部下載的檔案雜湊跟 assets-lock.json 不同時，確認過再用這個更新
//   node build.mjs dev            把 R2 大檔放進本機 R2，開 wrangler dev（127.0.0.1:8799）
//   node build.mjs paths          印出工作資料夾與部署、上傳 R2 要用的指令
//   node build.mjs export-source <資料夾>  把要公開的修改原始碼（補丁、建置腳本、設定檔、授權）匯出到公開 repo 的本機資料夾
//   node build.mjs latest-upstream  印出上游最新的正式版本與 commit（每週檢查流程用）
//   node build.mjs check-upstream <tag> <commit>  不執行上游程式、只用 git 與讀檔檢查新版本（每週檢查流程用，輸出 Markdown）
//
// 部署與上傳 R2 刻意不寫進這支腳本：那兩個指令要直接打，Claude Code 的 permissions.ask 才攔得到。
//
// 建置會執行上游的程式碼（vite 設定、建置腳本），所以只在本機、看過版本說明與程式差異後才建置（指南第 9.2 節）；
// GitHub Actions 只跑 check-upstream。為了縮小影響範圍：套件安裝不執行安裝腳本（--ignore-scripts），
// 子程式只拿到建置需要的環境變數（childEnv）。
//
// 工作資料夾：環境變數 PDF_TOOL_WORK；沒設時 Windows 用 %LOCALAPPDATA%\pdf-tool-build，其他用 ~/.cache/pdf-tool-build。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const upstream = readJson(join(HERE, 'upstream.json'));
const { bucket: R2_BUCKET, files: r2List } = readJson(join(HERE, 'r2-files.json'));
const securityHeaders = readJson(join(HERE, 'security-headers.json'));
const LOCK_PATH = join(HERE, 'assets-lock.json');
const PATCH_DIR = join(HERE, 'patches');
const WRANGLER_CONF = join(HERE, 'worker', 'wrangler.jsonc');

// 修改後的原始碼公開的位置（AGPL 第 13 條：讓使用者取得），顯示在每頁頁尾
const SOURCE_URL = 'https://github.com/cmurx/pdf-tool-source';
// 用 API 讀（raw.githubusercontent.com 快取約 5 分鐘，API 約 1 分鐘；未登入每小時 60 次，夠用）
const SOURCE_API = 'https://api.github.com/repos/cmurx/pdf-tool-source/contents';
// 公開 repo 放的檔案（export-source 匯出、建置時比對）；Worker 與指南不是 BentoPDF 的衍生作品，不放
const PUBLIC_FILES = ['build.mjs', 'upstream.json', 'assets-lock.json', 'r2-files.json', 'security-headers.json'];

// 建置設定（上游的 VITE_* 與建置旗標）。WASM 等資源用相對路徑，同一份輸出在本機與正式站都能用。
const BUILD_ENV = {
  SIMPLE_MODE: 'true',              // 自架版首頁，拿掉行銷區塊
  DISABLE_GITHUB_STARS: 'true',     // 不呼叫 api.github.com
  SITE_URL: 'https://pdf.cmu.tw',   // 各頁的 canonical、多語系連結；上游預設指向 bentopdf.com
  VITE_DEFAULT_LANGUAGE: 'zh-TW',   // 預設繁體中文，介面可切換英文等語言
  VITE_BRAND_NAME: 'PDF 工具箱',     // 2026-10-16 系統負責人決定
  VITE_FOOTER_TEXT: `以 BentoPDF（AGPL-3.0）建置，修改的原始碼：${SOURCE_URL}`,
  // patches/0001：讓 Office 轉 PDF 的 LibreOffice 載入中文字型（跟 OCR 共用同一個字型檔）
  VITE_LIBREOFFICE_FONT_URLS: '/wasm/ocr/fonts/NotoSansCJKtc-Regular.otf',
  VITE_WASM_PYMUPDF_URL: '/wasm/pymupdf/',
  VITE_WASM_GS_URL: '/wasm/gs/',
  VITE_WASM_CPDF_URL: '/wasm/cpdf/',
  VITE_TESSERACT_WORKER_URL: '/wasm/ocr/worker.min.js',
  VITE_TESSERACT_CORE_URL: '/wasm/ocr/core',
  VITE_TESSERACT_LANG_URL: '/wasm/ocr/lang-data',
  VITE_TESSERACT_AVAILABLE_LANGUAGES: 'chi_tra,eng',
  VITE_OCR_FONT_BASE_URL: '/wasm/ocr/fonts',
  VITE_EMBEDPDF_FONTS_URL: '/wasm/editor-fonts',
  // 數位簽章的憑證鏈代理：不架（2026-10-16 系統負責人決定，指南第 7 節）
  VITE_CORS_PROXY_URL: '',
};
// 子程式（git、npm、上游的建置程式）能拿到的環境變數；其他的（例如權杖）一律不傳。
// npm 的設定只放行快取、registry、代理這幾個，登入用的（_auth、_authToken 等）不傳
const CHILD_ENV_KEYS = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|HOMEDRIVE|HOMEPATH|USERPROFILE|USERNAME|USER|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|COMMONPROGRAMFILES|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|OS|LANG|LC_ALL|TERM|CI|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY|NPM_CONFIG_(CACHE|REGISTRY|PROXY|HTTPS_PROXY|NOPROXY|STRICT_SSL|CAFILE|FETCH_RETRIES|FETCH_TIMEOUT))$/i;
const SECRET_LIKE = /AUTH|TOKEN|PASSWORD|SECRET|_KEY/i;
const OCR_LANGS = ['chi_tra', 'eng'];
const OCR_FONTS = ['Noto Sans TC', 'Noto Sans'];
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_ASSET_FILES = 20000;
const DEV_PORT = 8799;

const WORK = process.env.PDF_TOOL_WORK
  || (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'pdf-tool-build')
    : join(homedir(), '.cache', 'pdf-tool-build'));
const SRC = join(WORK, `src-${upstream.commit.slice(0, 12)}`);
const OUT = join(WORK, 'out');
const ASSETS_DIR = join(OUT, 'assets');
const R2_DIR = join(OUT, 'r2');
const INSTALLED_MARK = join(SRC, 'node_modules', '.pdf-tool-installed');

if (HERE.toLowerCase().includes('onedrive') && WORK.toLowerCase().includes('onedrive')) {
  fail(`工作資料夾在 OneDrive 裡（${WORK}），幾百 MB 的建置檔會被同步；請把 PDF_TOOL_WORK 設到 OneDrive 外面`);
}

const cmd = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'build';
const updateLock = process.argv.includes('--update-lock');

if (cmd === 'build') await build();
else if (cmd === 'dev') dev();
else if (cmd === 'paths') printPaths();
else if (cmd === 'export-source') exportSource(process.argv[3]);
else if (cmd === 'latest-upstream') latestUpstream();
else if (cmd === 'check-upstream') checkUpstream(process.argv[3], process.argv[4]);
else fail(`不認得的指令：${cmd}`);

// ---------------------------------------------------------------------------

async function build() {
  const t0 = Date.now();
  checkWranglerConfig();
  mkdirSync(WORK, { recursive: true });
  prepareSource();

  applyPatches();
  syncLibreOfficeWorker();

  const pkg = readJson(join(SRC, 'package.json'));
  const env = childEnv({ ...BUILD_ENV, npm_package_version: pkg.version });
  rmSync(join(SRC, 'dist'), { recursive: true, force: true });
  // 上游的 npm run build 用 POSIX 的環境變數寫法，Windows 跑不了，所以照它的步驟逐一執行
  // （略過 sitemap、nginx 安全標頭與 SEO 檢查：這裡用不到，安全標頭由 _headers 與 Worker 加）
  run('npx', ['tsc'], { cwd: SRC, env });
  run('npx', ['vite', 'build'], { cwd: SRC, env });
  run('node', ['scripts/generate-i18n-pages.mjs'], {
    cwd: SRC, env: { ...env, NODE_OPTIONS: '--max-old-space-size=3072' },
  });

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  renameSync(join(SRC, 'dist'), ASSETS_DIR);
  await addExternalAssets(pkg);
  const removed = removePrecompressed(ASSETS_DIR);
  moveLargeFilesToR2();
  writeHeadersFile();

  const files = listFiles(ASSETS_DIR);
  const total = files.reduce((s, f) => s + f.size, 0);
  if (files.length > MAX_ASSET_FILES) fail(`靜態檔 ${files.length} 個，超過 ${MAX_ASSET_FILES}`);
  writeFileSync(join(OUT, 'build-info.json'), JSON.stringify({
    tag: upstream.tag, commit: upstream.commit, builtAt: new Date().toISOString(),
    assetFiles: files.length, assetBytes: total, r2Files: r2List,
  }, null, 2));

  log(`完成：${upstream.tag}（${upstream.commit.slice(0, 7)}），${Math.round((Date.now() - t0) / 1000)} 秒`);
  log(`靜態檔 ${files.length} 個、${mb(total)} MB；刪除預先壓縮副本 ${removed} 個；R2 大檔 ${r2List.length} 個`);
  await checkPublicSource();
  printPaths();
}

// 部署的版本跟公開的原始碼要一致（AGPL）。只提醒不擋：Actions 上試建置新版本時一定會不同
async function checkPublicSource() {
  const local = [...PUBLIC_FILES, ...listPatches().map((p) => `patches/${p}`)];
  const differ = [];
  for (const rel of local) {
    try {
      const res = await fetch(`${SOURCE_API}/${rel}?ref=main`, { headers: { Accept: 'application/vnd.github.raw' } });
      const mine = readFileSync(join(HERE, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n');
      if (!res.ok || (await res.text()).replace(/\r\n/g, '\n') !== mine) differ.push(rel);
    } catch {
      differ.push(rel);
    }
  }
  if (differ.length) {
    console.warn(`[pdf-tool] 提醒：公開的原始碼（${SOURCE_URL}）跟本機不同：${differ.join('、')}。部署前用 node build.mjs export-source 更新並 push（剛 push 完約 1 分鐘內會誤報）`);
  } else {
    log('公開的原始碼跟本機一致');
  }
}

function exportSource(dir) {
  if (!dir) fail('給公開 repo 的本機資料夾，例如 node build.mjs export-source C:\\GitRepos\\pdf-tool-source');
  if (dir.toLowerCase().includes('onedrive')) fail('公開 repo 的資料夾不要放在 OneDrive 裡（.git 會被同步）');
  mkdirSync(join(dir, 'patches'), { recursive: true });
  for (const f of readdirSync(join(dir, 'patches'))) if (f.endsWith('.patch')) rmSync(join(dir, 'patches', f));
  for (const rel of PUBLIC_FILES) cpSync(join(HERE, rel), join(dir, rel));
  for (const p of listPatches()) cpSync(join(PATCH_DIR, p), join(dir, 'patches', p));
  cpSync(join(PATCH_DIR, 'README.md'), join(dir, 'patches', 'README.md'));
  const license = join(SRC, 'LICENSE');
  if (!existsSync(license)) fail('找不到上游的 LICENSE（AGPL-3.0 全文），先跑一次 node build.mjs');
  cpSync(license, join(dir, 'LICENSE'));
  writeFileSync(join(dir, '.gitattributes'), 'patches/*.patch text eol=lf\n');
  writeFileSync(join(dir, 'README.md'), publicReadme());
  log(`已匯出到 ${dir}；在那裡 git add、commit、push（公開 repo，push 前先看過 git diff）`);
}

function publicReadme() {
  return `# PDF 工具箱（pdf.cmu.tw）的修改原始碼

[pdf.cmu.tw](https://pdf.cmu.tw) 是以 [BentoPDF](https://github.com/alam00000/bentopdf)（AGPL-3.0）建置的 PDF 工具網站，檔案全程在使用者的瀏覽器裡處理、不上傳。依 AGPL-3.0 第 13 條，這裡公開網站所用的修改版原始碼。

## 網站跑的是什麼

上游 BentoPDF [${upstream.tag}](https://github.com/alam00000/bentopdf/tree/${upstream.commit})（commit \`${upstream.commit}\`），加上：

1. [\`patches/\`](patches/) 的補丁（說明見 [patches/README.md](patches/README.md)）。
2. 把上游 \`public/libreoffice-wasm/browser.worker.global.js\` 換成 \`node_modules/@matbee/libreoffice-converter/dist/browser.worker.global.js\`（上游內附的舊版不支援注入字型）。
3. [\`build.mjs\`](build.mjs) 開頭 \`BUILD_ENV\` 的建置設定（品牌名稱、預設語言、WASM 與字型改從同網域提供），以及 [\`security-headers.json\`](security-headers.json) 產生的安全標頭。

## 重現

需要 Node.js 22 以上與 git：

\`\`\`sh
node build.mjs
\`\`\`

\`build.mjs\` 會抓上游指定的版本、核對 commit 雜湊、套補丁、建置，並下載 WASM 與字型（npm 以外的下載核對 [\`assets-lock.json\`](assets-lock.json) 的 SHA-256）。輸出在工作資料夾的 \`out/assets\`（超過 25 MiB 的檔在 \`out/r2\`）。\`worker/\` 是網站的部署設定（不是 BentoPDF 的衍生作品），不在這個 repo：沒有它時 \`build.mjs\` 會略過部署設定的核對，建置照常；\`dev\` 指令需要它。

## 授權

AGPL-3.0，見 [LICENSE](LICENSE)。BentoPDF 的著作權屬於其作者。

---

# Modified source of PDF 工具箱 (pdf.cmu.tw)

[pdf.cmu.tw](https://pdf.cmu.tw) runs [BentoPDF](https://github.com/alam00000/bentopdf) (AGPL-3.0); all processing happens in the browser. As required by AGPL-3.0 section 13, this repository provides the modified source: upstream ${upstream.tag} (\`${upstream.commit}\`) + the patches in [\`patches/\`](patches/) + the LibreOffice worker swap described above, built with \`node build.mjs\`.
`;
}

function listPatches() {
  return existsSync(PATCH_DIR) ? readdirSync(PATCH_DIR).filter((f) => f.endsWith('.patch')).sort() : [];
}

function prepareSource() {
  // core.autocrlf=false：保持上游的 LF，補丁才套得上（Windows 的 git 常設成 true）
  const ok = existsSync(join(SRC, '.git'))
    && git(['rev-parse', 'HEAD'], SRC) === upstream.commit
    && git(['config', '--get', 'core.autocrlf'], SRC) === 'false';
  if (!ok) {
    // 換了上游版本：舊版的原始碼與套件（數百 MB）一起清掉；只刪 build.mjs 自己建的 src-<12 位 commit>
    if (existsSync(WORK)) {
      for (const d of readdirSync(WORK)) if (/^src-[0-9a-f]{12}$/.test(d)) rmSync(join(WORK, d), { recursive: true, force: true });
    }
    log(`抓上游 ${upstream.tag} 到 ${SRC}`);
    run('git', ['-c', 'advice.detachedHead=false', 'clone', '--config', 'core.autocrlf=false', '--depth', '1', '--branch', upstream.tag, '--quiet', upstream.repo, SRC]);
    const head = git(['rev-parse', 'HEAD'], SRC);
    if (head !== upstream.commit) {
      rmSync(SRC, { recursive: true, force: true });
      fail(`上游標籤 ${upstream.tag} 現在指向 ${head}，跟 upstream.json 記的 ${upstream.commit} 不同。標籤可能被改過，先查清楚再更新 upstream.json`);
    }
  } else {
    log(`沿用已抓好的上游原始碼 ${SRC}`);
    // 上次建置套過的補丁先還原、補丁新增的檔案也清掉（-fd 不含 .gitignore 排除的 node_modules），回到跟上游一模一樣
    run('git', ['checkout', '--quiet', '--', '.'], { cwd: SRC });
    run('git', ['clean', '-fdq'], { cwd: SRC });
  }
  const dirty = git(['status', '--porcelain'], SRC);
  if (dirty) fail(`上游原始碼有修改或多出檔案，跟 ${upstream.tag} 不一致：\n${dirty}`);
  // 安裝成功才寫標記；中斷過的安裝沒有標記，整個重裝
  if (!existsSync(INSTALLED_MARK)) {
    rmSync(join(SRC, 'node_modules'), { recursive: true, force: true });
    run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: SRC, env: childEnv() });
    writeFileSync(INSTALLED_MARK, `${upstream.commit}\n`);
  }
}

// patches/*.patch 依檔名順序套用。套不上就停：上游可能已經修好（拿掉補丁）或改了寫法（重做補丁）
function applyPatches() {
  for (const p of listPatches()) {
    const file = join(PATCH_DIR, p);
    const check = spawnSync('git', ['apply', '--check', file], { cwd: SRC, encoding: 'utf8', env: childEnv() });
    if (check.status !== 0) {
      fail(`補丁 ${p} 套不上 ${upstream.tag}：上游可能已經修好（確認後刪掉補丁）或改了寫法（重做補丁）。\n${check.stderr}`);
    }
    run('git', ['apply', file], { cwd: SRC });
    log(`套用補丁 ${p}`);
  }
}

// 上游 public/libreoffice-wasm/ 內附的 worker 是舊版，不支援注入字型；換成已安裝的 @matbee/libreoffice-converter 的版本。
// 上游換成新版後這一步就不做事（指南第 7 節）
function syncLibreOfficeWorker() {
  const vendored = join(SRC, 'public', 'libreoffice-wasm', 'browser.worker.global.js');
  const installed = join(SRC, 'node_modules', '@matbee', 'libreoffice-converter', 'dist', 'browser.worker.global.js');
  if (!existsSync(vendored) || !existsSync(installed)) fail('找不到 LibreOffice 的 browser.worker.global.js，上游可能改了結構');
  if (readFileSync(vendored, 'utf8').includes('share/fonts')) {
    log('上游內附的 LibreOffice worker 已支援字型注入，不用換（可以拿掉這一步）');
    return;
  }
  if (!readFileSync(installed, 'utf8').includes('share/fonts')) fail('已安裝的 LibreOffice worker 也不支援字型注入，Office 轉 PDF 的中文會變方框');
  cpSync(installed, vendored);
  const ver = readJson(join(SRC, 'node_modules', '@matbee', 'libreoffice-converter', 'package.json')).version;
  log(`LibreOffice worker 換成 @matbee/libreoffice-converter ${ver} 的版本（支援字型注入）`);
}

// 上游預設在使用時才從 jsDelivr 等 CDN 抓的資源，改成建置時下載、跟網站一起部署（指南第 2.2 節）
async function addExternalAssets(pkg) {
  const lock = existsSync(LOCK_PATH) ? readJson(LOCK_PATH) : { files: {} };
  const seen = {};
  const tmp = mkdtempSync(join(tmpdir(), 'pdf-tool-assets-'));
  const w = join(ASSETS_DIR, 'wasm');
  const { versions, ocrFontUrls, editorFontPacks } = readUpstreamConfig(SRC);

  // npm 套件：npm pack 會核對 registry 的完整性雜湊，不執行套件的腳本
  const pack = (spec) => {
    const r = spawnSync('npm', ['pack', spec, '--silent'], { cwd: tmp, shell: true, encoding: 'utf8', env: childEnv() });
    if (r.status !== 0) fail(`npm pack ${spec} 失敗：${r.stderr}`);
    const file = r.stdout.trim().split(/\r?\n/).pop();
    const out = join(tmp, file.replace(/\.tgz$/, ''));
    mkdirSync(out, { recursive: true });
    const x = spawnSync('tar', ['-xzf', file, '-C', out], { cwd: tmp, encoding: 'utf8', env: childEnv() });
    if (x.status !== 0) fail(`解壓 ${file} 失敗：${x.stderr}`);
    log(`  ${spec}`);
    return join(out, 'package');
  };
  // 其他網址：沒有套件管理器幫忙核對，自己記 SHA-256（assets-lock.json）
  const download = async (url, to) => {
    const res = await fetch(url);
    if (!res.ok) fail(`下載失敗（HTTP ${res.status}）：${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const sha = createHash('sha256').update(buf).digest('hex');
    const known = lock.files[url];
    if (known && known !== sha && !updateLock) fail(`${url} 的內容變了（記錄 ${known}，現在 ${sha}）。確認來源可信再用 --update-lock`);
    if (!known && !updateLock) fail(`${url} 還沒記錄雜湊。第一次或上游換了網址時，確認來源可信再用 --update-lock`);
    seen[url] = sha;
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, buf);
    log(`  ${url}`);
  };

  log('下載外部資源');
  cpSync(pack(`@bentopdf/pymupdf-wasm@${versions.pymupdf}`), join(w, 'pymupdf'), { recursive: true });
  const gs = pack(`@bentopdf/gs-wasm@${versions.ghostscript}`);
  cpSync(existsSync(join(gs, 'assets')) ? join(gs, 'assets') : gs, join(w, 'gs'), { recursive: true });
  const cpdf = pack(`coherentpdf@${versions.cpdf}`);
  cpSync(existsSync(join(cpdf, 'dist')) ? join(cpdf, 'dist') : cpdf, join(w, 'cpdf'), { recursive: true });
  cpSync(join(pack(`tesseract.js@${versions.tesseract}`), 'dist', 'worker.min.js'), join(w, 'ocr', 'worker.min.js'));
  cpSync(pack(`tesseract.js-core@${versions.tesseractCore}`), join(w, 'ocr', 'core'), { recursive: true });
  for (const f of editorFontPacks) {
    const p = pack(`@embedpdf/${f.name}@${f.version}`);
    cpSync(join(p, 'fonts', f.file), join(w, 'editor-fonts', `${f.name}@${f.version}`, 'fonts', f.file));
  }
  for (const lang of OCR_LANGS) {
    await download(`https://cdn.jsdelivr.net/npm/@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`,
      join(w, 'ocr', 'lang-data', `${lang}.traineddata.gz`));
  }
  for (const url of ocrFontUrls) await download(url, join(w, 'ocr', 'fonts', url.split('/').pop()));
  rmSync(tmp, { recursive: true, force: true });

  if (updateLock) {
    writeFileSync(LOCK_PATH, JSON.stringify({
      說明: 'build.mjs 從 npm 以外下載的檔案的 SHA-256。內容變了建置會停下來；確認來源可信後用 node build.mjs --update-lock 更新並 commit。',
      files: seen,
    }, null, 2) + '\n');
    log(`已更新 ${relative(HERE, LOCK_PATH)}`);
  }
}

// build.mjs 從上游原始碼讀的設定（只讀檔、不執行）。建置時找不到就停；check-upstream 傳 report 收集問題
function readUpstreamConfig(dir, report = fail) {
  const read = (rel) => {
    if (existsSync(join(dir, rel))) return readFileSync(join(dir, rel), 'utf8');
    report(`上游找不到 ${rel}`);
    return '';
  };
  const find = (text, re, what) => {
    const m = text.match(re);
    if (!m) report(`上游原始碼找不到${what}（上游可能改了寫法，要更新 build.mjs）`);
    return m ? m[1] : null;
  };
  let lock = { packages: {} };
  try { lock = JSON.parse(read('package-lock.json') || '{"packages":{}}'); } catch { report('上游的 package-lock.json 讀不了'); }
  const cdnVersion = read('src/js/const/cdn-version.ts');
  const wasmProvider = read('src/js/utils/wasm-provider.ts');
  const fontMappings = read('src/js/config/font-mappings.ts');
  const editorFonts = read('src/js/config/editor-fonts.ts');
  const lockVersion = (name) => lock.packages?.[`node_modules/${name}`]?.version ?? (report(`package-lock.json 找不到 ${name} 的版本`), null);
  const versions = {
    pymupdf: find(cdnVersion, /pymupdf: '([^']+)'/, ' PyMuPDF 版本'),
    ghostscript: find(cdnVersion, /ghostscript: '([^']+)'/, ' Ghostscript 版本'),
    cpdf: find(wasmProvider, /coherentpdf@([\d.]+)/, ' CoherentPDF 版本'),
    tesseract: lockVersion('tesseract.js'),
    tesseractCore: lockVersion('tesseract.js-core'),
  };
  const ocrFontUrls = OCR_FONTS.map((family) => find(fontMappings, new RegExp(`'${family}':\\s*'([^']+)'`), ` ${family} 字型網址`)).filter(Boolean);
  const editorFontPacks = [...editorFonts.matchAll(/'(fonts-[a-z]+)@([\d.]+)\/fonts\/([^']+)'/g)]
    .map((m) => ({ name: m[1], version: m[2], file: m[3] }));
  if (!editorFontPacks.length) report('上游原始碼找不到編輯器的備用字型清單（editor-fonts.ts）');
  return { versions, ocrFontUrls, editorFontPacks };
}

// vite 預先壓好的 .br／.gz 副本；Cloudflare 會自己壓縮。原檔存在才刪（LibreOffice 的 .gz 本身就是原檔）
function removePrecompressed(dir) {
  let n = 0;
  for (const f of listFiles(dir)) {
    if (/\.(br|gz)$/.test(f.path) && existsSync(f.path.replace(/\.(br|gz)$/, ''))) { rmSync(f.path); n++; }
  }
  return n;
}

function moveLargeFilesToR2() {
  const large = listFiles(ASSETS_DIR).filter((f) => f.size > MAX_ASSET_BYTES).map((f) => f.rel).sort();
  const expected = [...r2List].sort();
  if (JSON.stringify(large) !== JSON.stringify(expected)) {
    fail(`超過 25 MiB 的檔案跟 r2-files.json 不一致。\n實際：${JSON.stringify(large)}\n清單：${JSON.stringify(expected)}\n上游新增或改了大檔：確認後更新 r2-files.json 與 worker/wrangler.jsonc 的 run_worker_first`);
  }
  for (const rel of large) {
    const to = join(R2_DIR, upstream.tag, ...rel.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    renameSync(join(ASSETS_DIR, ...rel.split('/')), to);
    log(`  R2：${rel}（${mb(statSync(to).size)} MB）`);
  }
}

// 靜態檔由 Cloudflare 直接送出，安全標頭靠 _headers；Worker 只處理 R2 大檔，自己加同一組標頭
function writeHeadersFile() {
  // 註解只用英文：這個檔交給 Cloudflare 解析，避免編碼問題
  const lines = ['# Generated by build.mjs from security-headers.json. Do not edit.', '/*', `  Content-Security-Policy: ${securityHeaders.csp.join('; ')}`];
  for (const [k, v] of Object.entries(securityHeaders.headers)) lines.push(`  ${k}: ${v}`);
  if (lines.some((l) => l.length > 2000)) fail('_headers 有一行超過 2,000 字（Cloudflare 的上限）');
  writeFileSync(join(ASSETS_DIR, '_headers'), lines.join('\n') + '\n');
}

// wrangler.jsonc 的 bucket 名稱與 run_worker_first 要跟 r2-files.json 一致：不一致時大檔會 404，或全部請求都經過 Worker。
// 公開 repo 沒有 worker/（不是 BentoPDF 的衍生作品），重現建置時略過
function checkWranglerConfig() {
  if (!existsSync(WRANGLER_CONF)) {
    log('沒有 worker/wrangler.jsonc，略過部署設定的核對（重現建置不需要）');
    return;
  }
  let conf;
  try {
    conf = JSON.parse(stripJsonComments(readFileSync(WRANGLER_CONF, 'utf8')));
  } catch (e) {
    fail(`worker/wrangler.jsonc 解析失敗：${e.message}`);
  }
  const problems = [];
  const buckets = (conf.r2_buckets || []).filter((b) => b.binding === 'LARGE_ASSETS');
  if (buckets.length !== 1 || buckets[0].bucket_name !== R2_BUCKET) problems.push(`LARGE_ASSETS 的 bucket_name 要是 ${R2_BUCKET}`);
  const first = conf.assets?.run_worker_first;
  const expected = r2List.map((rel) => `/${rel}`).sort();
  if (!Array.isArray(first) || JSON.stringify([...first].sort()) !== JSON.stringify(expected)) {
    problems.push(`assets.run_worker_first 要剛好是 ${JSON.stringify(expected)}（現在是 ${JSON.stringify(first)}）`);
  }
  if (problems.length) fail(`worker/wrangler.jsonc 跟 r2-files.json 不一致：${problems.join('；')}`);
}

// 拿掉 JSONC 的 // 與 /* */ 註解（字串裡的不動）
function stripJsonComments(text) {
  let out = '';
  for (let i = 0, inStr = false; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true; out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

// 每週檢查流程用：只用 git 下載與讀檔檢查上游的新版本，不安裝套件、不執行上游的任何程式。
// 輸出 Markdown（放進 issue），上游來的字串先拿掉反引號與角括號，避免在 issue 裡變成連結或跳出程式碼框
function checkUpstream(tag, commit) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag || '') || !/^[0-9a-f]{40}$/.test(commit || '')) fail('用法：node build.mjs check-upstream <vX.Y.Z> <40 位 commit>');
  const clean = (s) => String(s).replace(/[`<>]/g, '').replace(/\r/g, '').trim();
  const dir = mkdtempSync(join(tmpdir(), 'pdf-tool-check-'));
  const rows = [];
  const add = (ok, item, note = '') => rows.push(`| ${ok ? '✅' : '❌'} | ${item} | ${note} |`);
  try {
    const r = spawnSync('git', ['-c', 'advice.detachedHead=false', 'clone', '--config', 'core.autocrlf=false', '--depth', '1', '--branch', tag, '--quiet', upstream.repo, dir],
      { encoding: 'utf8', env: childEnv() });
    if (r.status !== 0) {
      add(false, `抓 ${tag}`, clean(r.stderr).slice(0, 300));
    } else {
      const head = git(['rev-parse', 'HEAD'], dir);
      add(head === commit, '標籤指向的 commit', head === commit ? commit.slice(0, 7) : `標籤指向 ${clean(head)}，ls-remote 是 ${commit}`);
      for (const p of listPatches()) {
        const c = spawnSync('git', ['apply', '--check', join(PATCH_DIR, p)], { cwd: dir, encoding: 'utf8', env: childEnv() });
        add(c.status === 0, `補丁 ${p} 套得上`, c.status === 0 ? '' : clean(c.stderr).split('\n').slice(0, 3).join(' / '));
      }
      const vendored = join(dir, 'public', 'libreoffice-wasm', 'browser.worker.global.js');
      const fixed = existsSync(vendored) && readFileSync(vendored, 'utf8').includes('share/fonts');
      rows.push(`| ${fixed ? '🎉' : '—'} | 上游內附的 LibreOffice worker 支援字型注入 | ${fixed ? '上游可能已修好中文字型：確認後可以拿掉補丁 0001 與 syncLibreOfficeWorker()' : '還沒，照常換新版 worker'} |`);
      const problems = [];
      const cfg = readUpstreamConfig(dir, (msg) => problems.push(msg));
      add(!problems.length, 'build.mjs 讀得到上游設定（WASM 版本、字型清單）', problems.map(clean).join('；'));
      if (!problems.length) {
        const v = cfg.versions;
        rows.push(`| — | 外部元件版本 | PyMuPDF ${clean(v.pymupdf)}、Ghostscript ${clean(v.ghostscript)}、CoherentPDF ${clean(v.cpdf)}、Tesseract ${clean(v.tesseract)} |`);
      }
      const large = existsSync(join(dir, 'public'))
        ? listFiles(join(dir, 'public')).filter((f) => f.size > MAX_ASSET_BYTES).map((f) => f.rel).sort()
        : [];
      const same = JSON.stringify(large) === JSON.stringify([...r2List].sort());
      add(same, 'public/ 裡超過 25 MiB 的檔跟 r2-files.json 一致', same ? '' : `實際：${large.map(clean).join('、') || '（無）'}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log('| 結果 | 項目 | 說明 |');
  console.log('|---|---|---|');
  for (const row of rows) console.log(row);
  console.log('\n只檢查不需要執行上游程式的項目；完整建置（vite、npm 套件裡的 WASM 大小等）在本機做。');
}

function dev() {
  if (!existsSync(ASSETS_DIR)) fail('還沒建置，先跑 node build.mjs');
  checkWranglerConfig();
  const info = readJson(join(OUT, 'build-info.json'));
  if (info.commit !== upstream.commit) fail(`建置輸出是 ${info.tag}，upstream.json 是 ${upstream.tag}，先重新建置`);
  const worker = join(HERE, 'worker');
  for (const rel of r2List) {
    run('npx', ['wrangler', 'r2', 'object', 'put', `${R2_BUCKET}/${upstream.tag}/${rel}`, '--file', join(R2_DIR, upstream.tag, ...rel.split('/')),
      '--content-type', 'application/octet-stream', '--local'], { cwd: worker });
  }
  log(`本機：http://127.0.0.1:${DEV_PORT}/（埠被佔用時 wrangler 照樣會印 Ready，先確認頁面標題）`);
  run('npx', ['wrangler', 'dev', '--assets', ASSETS_DIR, '--ip', '127.0.0.1', '--port', String(DEV_PORT)], { cwd: worker });
}

function printPaths() {
  log(`工作資料夾：${WORK}`);
  log(`靜態檔：${ASSETS_DIR}`);
  log('上傳 R2（每個大檔一次，在 PDF工具/worker 執行；版本沒換就不用重傳）：');
  for (const rel of r2List) {
    console.log(`  npx wrangler r2 object put ${R2_BUCKET}/${upstream.tag}/${rel} --file "${join(R2_DIR, upstream.tag, ...rel.split('/'))}" --content-type application/octet-stream --remote`);
  }
  log('部署（在 PDF工具/worker 執行；先上傳 R2）：');
  console.log(`  npx wrangler deploy --assets "${ASSETS_DIR}"`);
}

// 上游最新的 vX.Y.Z 正式版。annotated 標籤取 ^{} 那一行（實際的 commit），lightweight 標籤直接取
function latestUpstream() {
  const r = spawnSync('git', ['ls-remote', '--tags', upstream.repo], { encoding: 'utf8', env: childEnv() });
  if (r.status !== 0) fail(`抓不到上游的標籤：${r.stderr}`);
  const tags = new Map();
  for (const line of r.stdout.trim().split('\n')) {
    const [sha, ref] = line.split('\t');
    const m = ref?.match(/^refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/);
    if (m && (m[2] || !tags.has(m[1]))) tags.set(m[1], sha);
  }
  if (!tags.size) fail('上游沒有 vX.Y.Z 的標籤');
  const num = (t) => t.slice(1).split('.').map(Number);
  const tag = [...tags.keys()].sort((a, b) => {
    const [x, y] = [num(a), num(b)];
    return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
  })[0];
  console.log(`tag=${tag}`);
  console.log(`commit=${tags.get(tag)}`);
  console.log(`current=${upstream.tag}`);
}

// ---------------------------------------------------------------------------

function childEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (CHILD_ENV_KEYS.test(k) && !SECRET_LIKE.test(k)) env[k] = v;
  return { ...env, ...extra };
}
function run(command, args, opts = {}) {
  const r = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', env: childEnv(), ...opts });
  if (r.status !== 0) fail(`${command} ${args.join(' ')} 失敗（${r.status}）`);
}
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: childEnv() });
  return r.status === 0 ? r.stdout.trim() : '';
}
function listFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push({ path: p, rel: relative(dir, p).split(sep).join('/'), size: statSync(p).size });
    }
  })(dir);
  return out;
}
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
}
function mb(n) { return (n / 1048576).toFixed(1); }
function log(s) { console.log(`[pdf-tool] ${s}`); }
function fail(s) { console.error(`[pdf-tool] 錯誤：${s}`); process.exit(1); }
