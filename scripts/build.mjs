// Build the Chrome extension into dist/ (and optionally a zip).
//   node scripts/build.mjs            release build (needs core/pkg from scripts/build-core.sh)
//   node scripts/build.mjs --mock     UI development build with a fake core (never publish)
//   node scripts/build.mjs --zip      release build + joker-hegemon-wallet-<version>.zip
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const src = join(root, 'extension/src');
const mock = process.argv.includes('--mock');
const zip = process.argv.includes('--zip');
const dist = join(root, mock ? 'dist-mock' : 'dist');
const pkgDir = join(root, 'core/pkg');
const wasm = join(pkgDir, 'joker_core_bg.wasm');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

if (!mock && !existsSync(wasm)) {
  console.error(`Missing ${wasm}. Run scripts/build-core.sh first, or use --mock for UI work.`);
  process.exit(1);
}

// UI-only builds have no compiled core: stub the wasm-bindgen module out.
const mockCorePlugin = {
  name: 'mock-core',
  setup(b) {
    b.onResolve({ filter: /joker_core\.js$/ }, () => ({ path: 'joker-core-stub', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      contents: 'export default async function init() {} export function call() { throw new Error("mock build"); }',
      loader: 'js',
    }));
  },
};

await build({
  entryPoints: ['popup.js', 'offscreen.js', 'core-worker.js', 'background.js'].map((f) => join(src, f)),
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  minify: !mock,
  sourcemap: mock ? 'inline' : false,
  splitting: false,
  define: { __MOCK__: mock ? 'true' : 'false' },
  // The mock core is only reachable when __MOCK__ is true; esbuild drops it otherwise.
  legalComments: 'none',
  logLevel: 'info',
  plugins: mock ? [mockCorePlugin] : [],
});

for (const f of ['popup.html', 'popup.css', 'offscreen.html']) cpSync(join(src, f), join(dist, f));
cpSync(join(root, 'extension/icons'), join(dist, 'icons'), { recursive: true });
mkdirSync(join(dist, 'assets'), { recursive: true });
cpSync(join(root, 'extension/assets/network-manifest.json'), join(dist, 'assets/network-manifest.json'));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
if (mock) {
  manifest.name += ' (UI mock — not a wallet)';
}
writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));

if (!mock) {
  cpSync(wasm, join(dist, 'joker_core_bg.wasm'));
  console.log(`core: ${(statSync(wasm).size / 1e6).toFixed(1)} MB`);
}

// Guard: a release build must not contain the mock core.
if (!mock) {
  const worker = readFileSync(join(dist, 'core-worker.js'), 'utf8');
  if (worker.includes('runMock')) throw new Error('mock core leaked into release build');
}

if (zip) {
  const name = `joker-hegemon-wallet-${pkg.version}.zip`;
  rmSync(join(root, name), { force: true });
  execFileSync('zip', ['-r', '-X', join(root, name), '.'], { cwd: dist, stdio: 'inherit' });
  console.log(`wrote ${name}`);
}
