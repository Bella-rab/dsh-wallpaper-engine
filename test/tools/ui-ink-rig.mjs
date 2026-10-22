#!/usr/bin/env node
/**
 * ui-ink-rig.mjs —— **「全局 UI 配色」前景色的真浏览器对照装置**（手动工具，不进 `npm run verify` 链）。
 *
 * 回答的问题：**用户把「全局配色」选成暗色之后，链接文字 / 「深度求索中…」/ 页签与焦点环 /
 * 文件图标这几处前景，在深色主题下到底与壁纸差多少对比度？**（issue #239）
 *
 * 单元守卫（`verify-glass-compositing` 的 G9 / G9b、`verify-client` 的 #239 判据）判的是
 * **代码形状与纯函数输出**；这个装置判的是**真实 Chromium 的计算样式** —— 把插件**注入的
 * 那一份样式表**（产物里的 CSS 模板）原样放进一个页面，挂上 body 的玻璃 / 主题属性，
 * 用 `getComputedStyle` 读四处前景令牌，再对现场采样到的壁纸底色算 WCAG 对比度。
 *
 * 两栏对照，缺一不可：
 *   · `fixed`   —— 当前产物（前景四项各写 `-light` / `-dark`）
 *   · `pre-fix` —— 在同一个页面上**再叠一层改前的深色孪生块**（两档同读标量），
 *                  复刻 issue 报告的形态。它必须**红**，否则这个装置就没有牙。
 *
 * ⚠️ 本装置的局限（结论必须连这句一起读）：
 *   · 宿主令牌由页面里的**最小替身**给出（取值取自 issue #239 的实测表），
 *     本装置只判**插件那一层覆盖**，不判宿主题调色板本身。
 *   · 壁纸是任意内容，**绝对 4.5:1 对前景令牌不可保证**（出厂 accent 自己在报告者的
 *     壁纸底上也只有 4.31:1）⇒ 判据是**不弱于出厂 accent**，而不是绝对红线。
 *   · 无头浏览器只用于**相对 A/B**；真机绝对值需报告者复测。
 *   · 不挂真壁纸（只取报告里采样到的 `rgb(50,43,42)` 作为背景），所以量的是令牌取值本身。
 *
 * 用法：
 *   node test/tools/ui-ink-rig.mjs [accent] [wallpaper-rgb] [--shots <dir>]
 *   例：node test/tools/ui-ink-rig.mjs '#242424' '50,43,42' --shots ../../shots-239
 *   `--shots` 会存下深色改前 / 改后 / 浅色 / 出厂 accent 四张真实截图，外加一张并排对比图，
 *   并**从截图的像素里**反算对比度（不依赖任何"假设的"背景色）：
 *     · 改前深色档 <1.5:1（字画了但与底同色）
 *     · 改后深色档 ≥3.0:1
 *   实测输出见 PR 描述。这两条是对 `getComputedStyle` 那组判据的**独立交叉验证**：
 *   前者问"令牌算出来是多少"，后者问"屏幕上到底画成什么样"。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

// `test/tools/` 比仓库根深一层 ⇒ 退**两层**（DEV-GUIDE §4.7 约定 2）。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { cssBodyOf } = await import(pathToFileURL(join(ROOT, 'test/tools/src-scope.mjs')).href);

// ── 参数 ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let shotsDir = null;
const shotsAt = argv.indexOf('--shots');
if (shotsAt >= 0) {
  shotsDir = argv[shotsAt + 1];
  if (!shotsDir) { console.error('--shots 后面要跟目录'); process.exit(2); }
  argv.splice(shotsAt, 2);
}
const ACCENT = argv[0] || '#242424';
const WALL = (argv[1] || '50,43,42').split(',').map((v) => Number(v.trim()));
if (WALL.length !== 3 || WALL.some((v) => !Number.isFinite(v))) {
  console.error('壁纸底色必须是 "r,g,b"（例如 50,43,42）');
  process.exit(2);
}
/** 出厂默认 accent —— 也是 `weUiInk` 的参考亮度来源。 */
const FACTORY_ACCENT = '#4f8cff';

const SRC = readFileSync(join(ROOT, 'lib/client.js'), 'utf8');
const floorL = Number(SRC.match(/const READABILITY_FLOOR = ([\d.]+);/)[1]);
const floorD = Number(SRC.match(/const READABILITY_FLOOR_DARK = ([\d.]+);/)[1]);
const CSS = new Function('READABILITY_FLOOR', 'READABILITY_FLOOR_DARK',
  'return `' + cssBodyOf(SRC) + '`;')(floorL, floorD);

/** 从产物里抽一个具名函数（花括号计数，容忍内联缩进）。 */
function extractFn(name) {
  const start = SRC.indexOf('function ' + name + '(');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1); }
  }
  return null;
}
const inkSrc = extractFn('weUiInk');
if (!inkSrc) {
  console.error('产物里找不到 weUiInk —— 本装置的前提是 #239 的修复已落地');
  process.exit(2);
}
const weUiInk = new Function('return (' + inkSrc + ')')();
const weClampSurfaceColor = (() => {
  const s = extractFn('weClampSurfaceColor');
  return s ? new Function('return (' + s + ')')() : (hex) => hex;
})();
const weAccentInk = (() => {
  const s = extractFn('weAccentInk');
  return s ? new Function('return (' + s + ')')() : () => '#ffffff';
})();

const FOREGROUND = ['link', 'file-icon', 'tab', 'deep-diving'];

/** 与 `applyEffects` 的 `uiPair()` 逐字同形：标量 + 按主题的一对。 */
function cssVars(accent) {
  const vars = {
    '--we-accent': accent,
    '--we-accent-src': accent,
    '--we-accent-ink': weAccentInk(accent),
    '--we-scrim-color': 'rgba(0,0,0,0.25)',
    // 与 applyEffects 同一条曲线：glassAlpha 默认 50 → 0.25 - 0.5*0.15 = 0.175
    '--we-glass-alpha': '0.175',
    '--we-glass-fidelity': '1',
    '--we-border-alpha': '0.35',
    '--we-blur': '20px',
    '--we-saturate': '1.3',
    '--we-glass-brightness': '1',
    '--we-media-filter': 'none',
    '--we-object-fit': 'cover',
    // 玻璃染色地板（applyEffects 用缺省 glassColor #ffffff 经按主题钳制后的结果）
    '--we-surface-tint-light': weClampSurfaceColor('#ffffff', 'light'),
    '--we-surface-tint-dark': weClampSurfaceColor('#ffffff', 'dark'),
    '--we-surface-tint-rgb-light': '255, 255, 255',
    '--we-surface-tint-rgb-dark': '28, 28, 28',
    '--we-ui-send': accent,
  };
  for (const name of FOREGROUND) {
    vars['--we-ui-' + name] = accent;
    vars['--we-ui-' + name + '-light'] = weUiInk(accent, 'light');
    vars['--we-ui-' + name + '-dark'] = weUiInk(accent, 'dark');
  }
  return vars;
}

// 改前形态：深色孪生块与浅色块逐字相同（两档同读标量）。
const PRE_FIX_OVERRIDE = `
body[data-ds-dark-theme][data-we-glass-page] {
  --dsw-alias-link: var(--we-ui-link, #4f8cff);
  --dsw-alias-label-deep-diving: var(--we-ui-deep-diving, #4f8cff);
  --dsw-alias-label-deep-diving-shimmer: color-mix(in srgb, var(--we-ui-deep-diving, #4f8cff) 62%, #ffffff);
  --dsw-alias-state-business-primary: var(--we-ui-tab, #4f8cff);
}
body[data-ds-dark-theme][data-we-glass-page] [data-presented-file] {
  --dsw-alias-link: var(--we-ui-file-icon, #4f8cff);
}`;

/**
 * 一页可截图的最小 DSH 会话面。
 *
 * 宿主令牌由本页的**最小替身**给出（浅 #4176e6 / 深 #7aaaff —— 取自 issue #239 的实测表）；
 * 插件那份注入样式表在它**之后**、且特异性更高 ⇒ 页面呈现的就是插件覆盖后的真实结果。
 */
const buildPage = ({ accent, theme, preFix }) => {
  const vars = cssVars(accent);
  const dark = theme === 'dark';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>#239 · ${dark ? 'dark' : 'light'} · ${preFix ? 'pre-fix' : 'fixed'} · ${accent}</title>
<style>
/* ── 宿主令牌的最小替身（不是被测对象；只提供背景与正文色）──────────────── */
body {
  --dsw-alias-label-primary: #0f1115;
  --dsw-alias-label-secondary: #3b3f46;
  --dsw-alias-link: #4176e6;
  --dsw-alias-label-deep-diving: color-mix(in srgb, #4176e6 70%, #0b1020);
  --dsw-alias-state-business-primary: #4176e6;
  color-scheme: light;
}
body[data-ds-dark-theme] {
  --dsw-alias-label-primary: #f9fafb;
  --dsw-alias-label-secondary: #c9ccd2;
  --dsw-alias-link: #7aaaff;
  --dsw-alias-label-deep-diving: color-mix(in srgb, #7aaaff 55%, #c9ccd2);
  --dsw-alias-state-business-primary: #7aaaff;
  color-scheme: dark;
}
/* ── 被测：插件注入的那份样式表（产物 CSS 模板原样求值）──────────────────── */
${CSS}
${preFix ? PRE_FIX_OVERRIDE : ''}
/* ── 装置自身的排版（与被测令牌无关，刻意写成字面量）────────────────────── */
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font: 14px/1.65 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: var(--dsw-alias-label-primary);
  overflow: hidden;
}
.wallpaper {
  position: fixed; inset: 0; z-index: 0;
  background:
    radial-gradient(1100px 620px at 18% 8%, #4a3c36 0%, rgba(74,60,54,0) 62%),
    radial-gradient(880px 680px at 84% 86%, #2c3a44 0%, rgba(44,58,68,0) 58%),
    radial-gradient(720px 520px at 56% 46%, #6b5040 0%, rgba(107,80,64,0) 62%),
    linear-gradient(158deg, #241d1a 0%, #14171c 100%);
}
.wallpaper::after {
  content: ""; position: absolute; inset: 0;
  background: repeating-linear-gradient(115deg, rgba(255,255,255,.022) 0 2px, transparent 2px 7px);
}
.surface {
  position: relative; z-index: 2;
  width: min(820px, 92vw); margin: 40px auto; padding: 24px 30px 22px;
  border-radius: 18px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  backdrop-filter: blur(var(--we-blur, 20px)) saturate(var(--we-saturate, 1.3));
  -webkit-backdrop-filter: blur(var(--we-blur, 20px)) saturate(var(--we-saturate, 1.3));
  box-shadow: 0 26px 64px rgba(0, 0, 0, .48);
}
.brand { font-size: 12px; letter-spacing: .12em; text-transform: uppercase; opacity: .72; margin: 0 0 14px; }
.probe { display: grid; grid-template-columns: 132px 1fr auto; align-items: center; gap: 14px; padding: 9px 0; border-top: 1px solid rgba(180,180,180,.14); }
.probe:first-of-type { border-top: 0; }
.probe > .label { font-size: 12px; color: var(--dsw-alias-label-secondary); letter-spacing: .02em; }
.probe > .val { font: 12px/1 ui-monospace, "Cascadia Mono", Consolas, monospace; color: var(--dsw-alias-label-secondary); opacity: .9; padding: 3px 7px; border-radius: 6px; background: rgba(127,127,127,.14); }
.sample { font-size: 15px; }
.sample.link { color: var(--dsw-alias-link); text-decoration: underline; text-underline-offset: 3px; }
.sample.deep { color: var(--dsw-alias-label-deep-diving); }
.sample.tab { color: var(--dsw-alias-state-business-primary); font-weight: 600; }
.sample.file { color: var(--dsw-alias-link); font: 600 14px/1 ui-monospace, Consolas, monospace; }
.caretbar { display: inline-block; width: 2px; height: 19px; vertical-align: -4px; background: var(--dsw-alias-state-business-primary); }
.inputline { display: flex; align-items: center; gap: 6px; font-size: 14px; color: var(--dsw-alias-label-secondary); }
.note { margin: 16px 0 0; padding-top: 12px; border-top: 1px solid rgba(180,180,180,.14); font-size: 11.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); opacity: .85; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: .02em; }
.badge.fixed { background: rgba(64,190,120,.18); color: #63d99a; }
.badge.prefix { background: rgba(230,80,80,.18); color: #ff8d8d; }
.badge.light { background: rgba(255,255,255,.14); color: #e7e9ee; }
</style></head>
<body ${dark ? 'data-ds-dark-theme' : ''} data-we-glass-page>
<div class="wallpaper"></div>

<main class="surface">
  <p class="brand">DSH · 会话 &nbsp;<span class="badge ${preFix ? 'prefix' : 'fixed'}">${preFix ? 'PRE-FIX' : 'FIXED'}</span> <span class="badge light">${dark ? 'DARK' : 'LIGHT'} · accent ${accent}</span></p>

  <div class="probe"><span class="label">链接文字</span>
    <span class="sample link">查看这份文档</span><span class="val" data-val="link">—</span></div>

  <div class="probe"><span class="label">深度求索状态</span>
    <span class="sample deep">深度求索中，用时 1 分 11 秒…</span><span class="val" data-val="deep">—</span></div>

  <div class="probe"><span class="label">页签 / 焦点环</span>
    <span class="sample tab">对话　<span style="opacity:.55;font-weight:400">轨迹</span></span><span class="val" data-val="tab">—</span></div>

  <div class="probe"><span class="label">文件图标</span>
    <span class="sample file"><span data-presented-file>&lt;/&gt;</span> report.md</span><span class="val" data-val="file">—</span></div>

  <div class="probe"><span class="label">输入光标</span>
    <span class="inputline">输入消息<span class="caretbar"></span></span><span class="val" data-val="caret">—</span></div>

  <p class="note">
    背景为合成壁纸（均值接近 issue 采样值 rgb(${WALL.join(', ')})）。四面宿主令牌由最小替身给出，
    插件注入的样式表原样加载 ⇒ 截图反映的就是插件覆盖后的真实计算值。
    光标为令牌示意条（真实光标随焦点闪烁，截图抓不到）。
  </p>
</main>

<script>
  window.__vars = ${JSON.stringify(vars)};
  for (const [k, v] of Object.entries(window.__vars)) {
    if (v === null || v === undefined) continue;
    document.body.style.setProperty(k, v);
  }
  // 自证：把每一行的**计算值**写进右侧徽标，截图即可复核。
  const pick = (sel) => document.querySelector(sel);
  const write = (key, text) => { const el = document.querySelector('[data-val="' + key + '"]'); if (el) el.textContent = text; };
  const v = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
  write('link', v('--dsw-alias-link'));
  write('deep', v('--dsw-alias-label-deep-diving'));
  write('tab', v('--dsw-alias-state-business-primary'));
  write('file', getComputedStyle(pick('[data-presented-file]')).getPropertyValue('--dsw-alias-link').trim());
  write('caret', getComputedStyle(pick('.caretbar')).backgroundColor);
</script>
</body></html>`;
};

// ── 零依赖 CDP 客户端（与 test/compat-harness-pages.mjs 同源做法）──────────────
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.onmessage = (ev) => this.#on(JSON.parse(String(ev.data)));
  }
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.onopen = () => res(new Cdp(ws));
      ws.onerror = () => rej(new Error('CDP WebSocket 连接失败：' + url));
    });
  }
  #on(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { res, rej, hint } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) rej(new Error(hint + ': ' + msg.error.message));
      else res(msg.result);
    }
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej, hint: method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
}

const CANDIDATES = process.platform === 'win32' ? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
] : process.platform === 'darwin' ? [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
] : [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];
const browserPath = CANDIDATES.find((p) => { try { readFileSync(p); return true; } catch { return false; } });
if (!browserPath) {
  console.error('找不到 Chromium 系浏览器（Chrome / Edge / Chromium）。本装置需要真浏览器。');
  process.exit(2);
}

// ── 对比度数学（WCAG 相对亮度）─────────────────────────────────────────────
function toRgb(h) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(h || ''));
  if (!m) return null;
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a, b) => {
  const la = lum(a), lb = lum(b);
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
};

// ── 最小 PNG 解码（只为量截图里**真实合成后**的像素色）────────────────────────
// CDP 的 captureScreenshot 给的是 PNG；这里只需要 8bit RGB/RGBA 的极小块，
// 所以自己 parse IHDR + zlib inflate + 逐行反滤波，不引第三方依赖。
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
        throw new Error('只支持 8bit RGB/RGBA PNG（实际 bd=' + bitDepth + ' ct=' + colorType + '）');
      }
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error('未知 PNG filter ' + filter);
      cur[x] = v & 0xff;
    }
  }
  return { width, height, bpp, data: out };
}

/** 取截图里某块区域的平均色（CSS 像素坐标，deviceScaleFactor=1 时 1:1）。 */
function averageBlock(png, x0, y0, w, h) {
  const { width, bpp, data } = png;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * width + x) * bpp;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * 字色近似：在文字区域里找**亮度最远离背景均值**的那个像素。
 *
 * 为什么不是取平均：一行文字里绝大部分像素是背景（字形只覆盖笔画），平均值几乎等于
 * 底色 —— 改前改后都会"差不多"，判据就没有牙。字形核心像素才是这条令牌真正画出来的
 * 颜色，所以取极值。抗锯齿会让边缘混色，极值点落在笔画内部，正是要找的。
 */
function glyphColor(png, x0, y0, w, h, bg) {
  const { width, bpp, data } = png;
  const bgL = lum(bg);
  let best = null;
  let bestD = -1;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * width + x) * bpp;
      const c = [data[i], data[i + 1], data[i + 2]];
      const d = Math.abs(lum(c) - bgL);
      if (d > bestD) { bestD = d; best = c; }
    }
  }
  return best || bg;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'we239-'));
const variants = {
  'dark-prefix': { accent: ACCENT, theme: 'dark', preFix: true },
  'dark-fixed': { accent: ACCENT, theme: 'dark', preFix: false },
  'light-fixed': { accent: ACCENT, theme: 'light', preFix: false },
  'dark-default-accent': { accent: FACTORY_ACCENT, theme: 'dark', preFix: false },
};
const pages = {};
for (const [id, opt] of Object.entries(variants)) {
  pages[id] = join(dir, id + '.html');
  writeFileSync(pages[id], buildPage(opt));
}

const port = 9333 + Math.floor(Math.random() * 300);
const child = spawn(browserPath, [
  '--headless=new', '--remote-debugging-port=' + port, '--user-data-dir=' + join(dir, 'profile'),
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
  '--force-color-profile=srgb', 'about:blank',
], { stdio: 'ignore' });

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
};

async function debuggerUrl() {
  for (let i = 0; i < 120; i++) {
    try {
      const j = await (await fetch('http://127.0.0.1:' + port + '/json/version')).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(150);
  }
  throw new Error('浏览器 DevTools 端口没起来（' + port + '）');
}

/** 只读令牌，不改 body 属性（截图用：主题由页面自身决定）。 */
const READ_EXPR = `(() => {
  const v = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
  const fileSpan = document.querySelector('[data-presented-file]');
  return {
    link: v('--dsw-alias-link'),
    deep: v('--dsw-alias-label-deep-diving'),
    tab: v('--dsw-alias-state-business-primary'),
    file: fileSpan ? getComputedStyle(fileSpan).getPropertyValue('--dsw-alias-link').trim() : '',
  };
})()`;

try {
  console.log('browser  = ' + browserPath);
  console.log('accent   = ' + ACCENT + ' · wallpaper = rgb(' + WALL.join(',') + ')');
  console.log('weUiInk(' + ACCENT + ') => ' + JSON.stringify({ light: weUiInk(ACCENT, 'light'), dark: weUiInk(ACCENT, 'dark') }) + '\n');

  const cdp = await Cdp.connect(await debuggerUrl());
  const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const page = targets.find((t) => t.type === 'page');
  const sessionId = (await cdp.send('Target.attachToTarget', { targetId: page.id, flatten: true })).sessionId;
  const evaluate = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) {
      throw new Error(String((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'evaluate failed'));
    }
    return r.result.value;
  };
  const load = async (file) => {
    await cdp.send('Page.navigate', { url: pathToFileURL(file).href }, sessionId);
    await sleep(900);   // 让 backdrop-filter 与字体都落定
  };

  const readVariant = async (id) => {
    await load(pages[id]);
    return evaluate(READ_EXPR);
  };

  const REF_HEX = FACTORY_ACCENT;
  const refRatio = contrast(toRgb(REF_HEX), WALL);
  console.log('reference: factory ' + REF_HEX + ' on this wallpaper = ' + refRatio.toFixed(2) + ':1\n');

  const LABELS = [['link', 'link'], ['deep', 'deep-diving'], ['tab', 'tab / focus ring'], ['file', 'file icon']];

  const fixed = await readVariant('dark-fixed');
  console.log('fixed   = ' + JSON.stringify(fixed));
  for (const [key, label] of LABELS) {
    const l = weUiInk(ACCENT, 'light');
    const d = fixed[key];
    const dr = toRgb(d);
    check(label + ': light / dark values diverge', l !== d, l + ' vs ' + d);
    check(label + ': dark is no worse than the factory accent on the same wallpaper',
      Boolean(dr) && contrast(dr, WALL) >= refRatio - 1e-9,
      (dr ? contrast(dr, WALL).toFixed(2) : '不可解析') + ':1 vs factory ' + refRatio.toFixed(2) + ':1');
  }

  const pre = await readVariant('dark-prefix');
  console.log('\npre-fix = ' + JSON.stringify(pre));
  for (const [key, label] of LABELS) {
    const l = weUiInk(ACCENT, 'light');
    const dr = toRgb(pre[key]);
    check('negative control: pre-fix ' + label + ' is identical across themes', pre[key] === l, l + ' vs ' + pre[key]);
    check('negative control: pre-fix ' + label + ' collapses on a dark wallpaper (<1.5:1)',
      Boolean(dr) && contrast(dr, WALL) < 1.5,
      (dr ? contrast(dr, WALL).toFixed(2) : '不可解析') + ':1');
  }

  // 浅色档与出厂 accent 的负对照：不应被本次修复改动。
  const light = await readVariant('light-fixed');
  check('light theme keeps the raw accent (the fix must not touch the readable side)',
    LABELS.every(([k]) => light[k] === ACCENT), JSON.stringify(light));
  const def = await readVariant('dark-default-accent');
  check('factory accent passes through byte-identically (zero regression for default users)',
    LABELS.every(([k]) => def[k] === FACTORY_ACCENT), JSON.stringify(def));

  // ── 截图 ────────────────────────────────────────────────────────────────
  if (shotsDir) {
    const out = resolve(process.cwd(), shotsDir);
    mkdirSync(out, { recursive: true });
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 1000, height: 640, deviceScaleFactor: 2, mobile: false }, sessionId);
    const shot = async (file) => {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
      writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log('shot -> ' + file);
      return file;
    };
    const files = {};
    const shots = {};
    for (const id of ['dark-prefix', 'dark-fixed', 'light-fixed', 'dark-default-accent']) {
      await load(pages[id]);
      // 采样区取「链接文字」那一行的文字块与它背后的卡片空白处：坐标由页面自报，避免写死魔数。
      shots[id] = await evaluate(`(() => {
        const row = document.querySelector('.probe');
        const s = row.querySelector('.sample.link');
        const r = s.getBoundingClientRect();
        const card = document.querySelector('.surface').getBoundingClientRect();
        return {
          text: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
          bg: [Math.round(card.right - 150), Math.round(r.top), 40, Math.round(r.height)],
        };
      })()`);
      files[id] = await shot(join(out, '239-' + id + '.png'));
    }

    // ── 实测像素：从截图里量出**真实合成后**的字色与卡片底色，再算对比度 ──────────
    // 这不依赖任何"假设的"背景色 —— 背景是 blur + tint 之后真正画出来的像素。
    const sampler = (rects) => {
      const png = decodePng(readFileSync(files[rects.id]));
      const k = Math.round(png.width / 1000);   // deviceScaleFactor=2 ⇒ 乘回 2
      const scale = (r) => [r[0] * k, r[1] * k, r[2] * k, r[3] * k];
      const bg = averageBlock(png, ...scale(rects.bg));
      const ink = glyphColor(png, ...scale(rects.text), bg);
      return { ink, bg };
    };
    const px = {};
    for (const id of Object.keys(files)) {
      px[id] = sampler({ id, ...shots[id] });
      console.log('pixels  ' + id.padEnd(22)
        + ' ink=rgb(' + px[id].ink.join(',') + ')  bg=rgb(' + px[id].bg.join(',') + ')'
        + '  contrast=' + contrast(px[id].ink, px[id].bg).toFixed(2) + ':1');
    }

    // 判据：同一块像素里，改前字色与底色几乎无差（这就是 issue 说的"字画了但看不见"），
    // 改后必须拉开到可读区间。两条都必须成立，否则装置没牙。
    const preC = contrast(px['dark-prefix'].ink, px['dark-prefix'].bg);
    const postC = contrast(px['dark-fixed'].ink, px['dark-fixed'].bg);
    check('pixels: the pre-fix dark link is effectively invisible (<1.5:1 measured off the screenshot)',
      preC < 1.5, preC.toFixed(2) + ':1 · ink=rgb(' + px['dark-prefix'].ink.join(',')
      + ') bg=rgb(' + px['dark-prefix'].bg.join(',') + ')');
    check('pixels: the fixed dark link separates from its backdrop (>=3.0:1 measured off the screenshot)',
      postC >= 3.0, postC.toFixed(2) + ':1 · ink=rgb(' + px['dark-fixed'].ink.join(',')
      + ') bg=rgb(' + px['dark-fixed'].bg.join(',') + ')');
    check('pixels: the light theme still renders the raw accent (unchanged by the fix)',
      contrast(px['light-fixed'].ink, px['light-fixed'].bg) > 3.0,
      contrast(px['light-fixed'].ink, px['light-fixed'].bg).toFixed(2) + ':1');


    // 并排对比图（两张真截图 + 结论条）
    const compare = join(out, '239-compare-dark.html');
    writeFileSync(compare, `<!doctype html><html><head><meta charset="utf-8"><style>
      html,body{margin:0;background:#0b0c10;color:#e8eaef;font:14px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
      .wrap{display:grid;grid-template-columns:1fr 1fr;gap:18px;padding:20px 22px 16px}
      figure{margin:0}
      figcaption{font-size:13px;letter-spacing:.04em;margin:0 0 8px;color:#9aa0aa}
      figcaption b{color:#e8eaef}
      img{width:100%;display:block;border-radius:10px;border:1px solid #2a2d34}
      .verdict{margin:0 22px 20px;padding:12px 16px;border-radius:10px;background:#15181e;border:1px solid #2a2d34;font-size:13px;color:#c8ccd4}
      .verdict code{font:12px ui-monospace,Consolas,monospace;background:#0f1115;padding:1px 5px;border-radius:5px}
    </style></head><body>
      <div class="wrap">
        <figure><figcaption><b>改前</b> · 深色档丢掉自己那一半（两档逐字相同）· accent ${ACCENT}</figcaption>
          <img src="${pathToFileURL(files['dark-prefix']).href}"></figure>
        <figure><figcaption><b>改后</b> · 前景四项各按主题取值 · accent ${ACCENT}</figcaption>
          <img src="${pathToFileURL(files['dark-fixed']).href}"></figure>
      </div>
      <div class="verdict">
        <b>同一条「链接文字」，同一块像素：</b>
        改前 <code>${pre.link}</code> / 改后深色档 <code>${fixed.link}</code>；
        从截图像素实测 —— 改前 <code>${preC.toFixed(2)}:1</code> → 改后 <code>${postC.toFixed(2)}:1</code>
        （字色 <code>rgb(${px['dark-fixed'].ink.join(',')})</code> vs 卡片底 <code>rgb(${px['dark-fixed'].bg.join(',')})</code>）。
        出厂 accent ${FACTORY_ACCENT} 在<b>同一张截图的同一背景</b>上是 <code>${contrast(px['dark-default-accent'].ink, px['dark-default-accent'].bg).toFixed(2)}:1</code>
        ⇒ 修复后不弱于出厂值。浅色档保持 <code>${light.link}</code> 不变。
      </div>
    </body></html>`);
    await cdp.send('Emulation.setDeviceMetricsOverride',
      { width: 2080, height: 780, deviceScaleFactor: 1.5, mobile: false }, sessionId);
    await cdp.send('Page.navigate', { url: pathToFileURL(compare).href }, sessionId);
    await sleep(900);
    await shot(join(out, '239-compare-dark.png'));
  }

  console.log('\n' + (failed ? failed + ' CHECK(S) FAILED' : 'ALL UI-INK RIG CHECKS PASSED'));
} finally {
  try { child.kill(); } catch { /* ignore */ }
  await sleep(400);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.exit(failed ? 1 : 0);
