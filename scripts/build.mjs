/* global process, console */
// Builds the npm package: dist/*.js + .d.ts (tsc), then checks that it
// loads in Node as plain JavaScript and bundles for browsers with no Node
// built-ins (peer packages stay external: the site installs them).
//
//   node scripts/build.mjs
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const dist = join(pkg, 'dist');
const find = (rel) => {
  for (let d = pkg; ; d = dirname(d)) {
    const p = join(d, 'node_modules', rel);
    if (existsSync(p)) return p;
    if (dirname(d) === d) throw new Error(`${rel} not found`);
  }
};

rmSync(dist, { recursive: true, force: true });
execFileSync(
  process.execPath,
  [find('typescript/bin/tsc'), '-p', join(pkg, 'tsconfig.build.json')],
  {
    stdio: 'inherit',
  },
);
const files = readdirSync(dist).filter((f) => f.endsWith('.js'));
console.log(`tsc: ${files.length} modules`);

// 1. Plain Node (no TypeScript loader): every entry point loads.
for (const entry of ['index.js', 'deposit.js', 'wallets.js', 'vault.js']) {
  const m = await import(pathToFileURL(join(dist, entry)).href);
  console.log(`node: ${entry} exports ${Object.keys(m).length}`);
}

// 2. Browsers: bundle each entry with esbuild, peers external. Fails on any
//    Node built-in (node:crypto, fs, ...) in the SDK's own code.
let esbuild;
try {
  esbuild = createRequire(import.meta.url)(find('esbuild'));
} catch {
  const pnpm = join(dirname(find('typescript')), '.pnpm');
  const dir = readdirSync(pnpm).find((d) => d.startsWith('esbuild@'));
  esbuild = createRequire(import.meta.url)(
    join(pnpm, dir, 'node_modules', 'esbuild'),
  );
}
const peers = [
  '@solana/web3.js',
  'buffer',
  '@scure/btc-signer',
  '@dfinity/agent',
  '@dfinity/candid',
  '@dfinity/principal',
];
for (const entry of ['index.js', 'deposit.js', 'wallets.js', 'vault.js']) {
  const r = await esbuild.build({
    entryPoints: [join(dist, entry)],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    external: peers,
    logLevel: 'silent',
    metafile: true,
  });
  const out = r.outputFiles[0].text;
  const bad = [
    /\bprocess\.(env|argv|exit)/,
    /\brequire\(/,
    /from ["']node:/,
  ].filter((x) => x.test(out));
  if (bad.length)
    throw new Error(`browser bundle of ${entry} uses Node: ${bad.join(', ')}`);
  const imports = [
    ...new Set(Object.values(r.metafile.outputs)[0].imports.map((i) => i.path)),
  ];
  console.log(
    `browser: ${entry} ${(out.length / 1024).toFixed(0)} KB, imports ${imports.join(', ') || 'nothing'}`,
  );
}
console.log('BUILD OK');
