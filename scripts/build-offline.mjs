// يحوّل index.html إلى نسخة تعمل بلا إنترنت داخل الـ APK:
//  - يبني Tailwind محلياً بدل CDN
//  - يضمّن خط Cairo
//  - ينسخ TensorFlow.js و coco-ssd ونموذجه محلياً
// كل خطوة تفشل تُترك على الإنترنت (CDN) دون إفشال البناء.
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const www = path.resolve(process.argv[2]);          // build/www
const work = path.resolve(process.argv[3]);         // build/offline (فيه node_modules)
const dry = process.env.OFFLINE_DRY === '1';
const file = path.join(www, 'index.html');
let html = fs.readFileSync(file, 'utf8');
const log = (...a) => console.log('[offline]', ...a);

// ---------- 1) Tailwind ----------
try {
  const cfg = html.match(/tailwind\.config\s*=\s*(\{[\s\S]*?\n  \});/);
  const comp = html.match(/<style type="text\/tailwindcss">([\s\S]*?)<\/style>/);
  if (!cfg || !comp) throw new Error('tailwind blocks not found');
  fs.writeFileSync(path.join(work, 'tw.config.cjs'), `module.exports = Object.assign({ content: [${JSON.stringify(path.join(www, 'index.html'))}] }, ${cfg[1]});`);
  fs.writeFileSync(path.join(work, 'input.css'), `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n${comp[1]}`);
  let css = '/* dry */';
  if (!dry) {
    execSync('npx tailwindcss -c tw.config.cjs -i input.css -o out.css --minify', { cwd: work, stdio: 'inherit' });
    css = fs.readFileSync(path.join(work, 'out.css'), 'utf8');
    if (css.length < 5000) throw new Error('tailwind output too small');
  }
  html = html.replace('<script src="https://cdn.tailwindcss.com"></script>', '');
  html = html.replace(/<script>\s*tailwind\.config[\s\S]*?<\/script>/, '');
  html = html.replace(comp[0], '');
  html = html.replace('</head>', `<style id="tw-built">${css}</style>\n</head>`);
  log('tailwind built', css.length, 'bytes');
} catch (e) { log('TAILWIND SKIPPED:', e.message); }

// ---------- 2) خط Cairo ----------
try {
  if (dry) throw new Error('dry run');
  const gurl = 'https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap';
  let fcss = await (await fetch(gurl, { headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36' } })).text();
  fs.mkdirSync(path.join(www, 'fonts'), { recursive: true });
  const urls = [...new Set([...fcss.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]))];
  if (!urls.length) throw new Error('no font urls');
  let i = 0;
  for (const u of urls) {
    const name = `cairo-${i++}.woff2`;
    fs.writeFileSync(path.join(www, 'fonts', name), Buffer.from(await (await fetch(u)).arrayBuffer()));
    fcss = fcss.split(u).join(`fonts/${name}`);
  }
  html = html.replace(/<link rel="preconnect"[^>]*>\s*/g, '');
  html = html.replace(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/, `<style id="font-local">${fcss}</style>`);
  log('fonts embedded', urls.length);
} catch (e) { log('FONT SKIPPED:', e.message); }

// ---------- 3) TensorFlow.js + coco-ssd + النموذج ----------
try {
  if (dry) throw new Error('dry run');
  const lib = path.join(www, 'lib'); fs.mkdirSync(path.join(lib, 'coco'), { recursive: true });
  fs.copyFileSync(path.join(work, 'node_modules/@tensorflow/tfjs/dist/tf.min.js'), path.join(lib, 'tf.min.js'));
  fs.copyFileSync(path.join(work, 'node_modules/@tensorflow-models/coco-ssd/dist/coco-ssd.min.js'), path.join(lib, 'coco-ssd.min.js'));
  const base = 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/';
  const mj = await (await fetch(base + 'model.json')).text();
  fs.writeFileSync(path.join(lib, 'coco/model.json'), mj);
  const paths = JSON.parse(mj).weightsManifest.flatMap(g => g.paths);
  for (const p of paths) {
    const r = await fetch(base + p); if (!r.ok) throw new Error('shard ' + p);
    fs.writeFileSync(path.join(lib, 'coco', p), Buffer.from(await r.arrayBuffer()));
  }
  html = html.replace('<head>', '<head>\n<script>window.MW_LOCAL_CV=true;</script>');
  log('cv libs + model local:', paths.length, 'shards');
} catch (e) { log('CV LOCAL SKIPPED:', e.message); }

fs.writeFileSync(file, html);
log('done');
