// Renders every fictional document in docs.mjs to two images:
//   out/<id>.clean.png  a straight scan
//   out/<id>.photo.png  the same page as a hand-held phone photo (tilt, shadow, soft focus)
//   node build.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DOCS } from './docs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out');
mkdirSync(out, { recursive: true });

const CHROME =
  process.env.CHROME ??
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!CHROME) throw new Error('Chrome not found; set CHROME to its path');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function body(doc) {
  const patient = doc.patient.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  let main = '';
  if (doc.kind === 'lab') {
    const rows = doc.sections
      .map(
        ([name, items]) =>
          `<tr class="sec"><td colspan="5">${esc(name)}</td></tr>` +
          items
            .map(
              ([n, v, u, r, f]) =>
                `<tr class="${f ? 'flag' : ''}"><td>${esc(n)}</td><td class="v">${esc(v)}</td><td>${esc(u)}</td><td>${esc(r)}</td><td class="f">${esc(f)}</td></tr>`,
            )
            .join(''),
      )
      .join('');
    main = `<table><thead><tr>${doc.head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>`;
  } else {
    main = doc.paragraphs.map(([h, p]) => `<h3>${esc(h)}</h3><p>${esc(p)}</p>`).join('');
  }
  return `<div class="page"><header><div class="lab">${esc(doc.lab)}</div><div class="title">${esc(doc.title)}</div></header>
<section class="patient">${patient}</section>${main}<footer>${esc(doc.footer)}</footer></div>`;
}

const CSS = `
*{box-sizing:border-box;margin:0}
html,body{width:1240px;height:1754px}
body{font-family:"Segoe UI","Yu Gothic UI","Meiryo",Arial,sans-serif;color:#15181c;background:#fff}
.page{width:1240px;height:1754px;padding:84px 88px;background:#fff;position:relative}
header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #15181c;padding-bottom:18px}
.lab{font-size:30px;font-weight:700;letter-spacing:.2px}
.title{font-size:22px;text-transform:uppercase;letter-spacing:2px}
.patient{display:grid;grid-template-columns:1fr 1fr;gap:8px 48px;margin:28px 0 34px;font-size:20px}
.patient div{display:flex;gap:14px}.patient span{color:#5a626c;min-width:170px}
table{width:100%;border-collapse:collapse;font-size:21px}
th{text-align:left;font-size:17px;text-transform:uppercase;letter-spacing:1px;color:#5a626c;border-bottom:1.5px solid #15181c;padding:10px 8px}
td{padding:11px 8px;border-bottom:1px solid #d9dde2}
tr.sec td{font-weight:700;font-size:18px;letter-spacing:1px;background:#f1f3f5;border-bottom:none;padding-top:14px}
td.v{font-variant-numeric:tabular-nums;font-weight:600}
tr.flag td.v,tr.flag td.f{font-weight:800}
h3{font-size:19px;text-transform:uppercase;letter-spacing:1.5px;margin:26px 0 8px;color:#5a626c}
p{font-size:22px;line-height:1.55}
footer{position:absolute;left:88px;right:88px;bottom:56px;font-size:15px;color:#7a828c;border-top:1px solid #d9dde2;padding-top:12px}
/* phone photo: desk, tilt, perspective, uneven light, slight softness */
body.photo{background:#6b5a4a;width:1400px;height:1900px;overflow:hidden}
body.photo .page{transform:translate(86px,70px) perspective(2600px) rotateX(7deg) rotateY(-5deg) rotateZ(2.2deg);transform-origin:50% 40%;box-shadow:0 30px 80px rgba(0,0,0,.45);filter:blur(.55px) contrast(.93) brightness(.97) sepia(.08)}
body.photo::after{content:"";position:fixed;inset:0;pointer-events:none;background:linear-gradient(118deg,rgba(0,0,0,.34) 0%,rgba(0,0,0,0) 46%),radial-gradient(circle at 78% 18%,rgba(255,255,255,.28),rgba(255,255,255,0) 34%)}
`;

for (const doc of DOCS) {
  for (const variant of ['clean', 'photo']) {
    const html = `<!doctype html><html lang="${doc.lang}"><meta charset="utf-8"><style>${CSS}</style><body class="${variant}">${body(doc)}</body></html>`;
    const htmlPath = join(out, `${doc.id}.${variant}.html`);
    const pngPath = join(out, `${doc.id}.${variant}.png`);
    writeFileSync(htmlPath, html);
    const size = variant === 'photo' ? '1400,1900' : '1240,1754';
    execFileSync(
      CHROME,
      ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${size}`, `--screenshot=${pngPath}`, pathToFileURL(htmlPath).href],
      { stdio: 'ignore' },
    );
    console.log('rendered', `${doc.id}.${variant}.png`);
  }
}
