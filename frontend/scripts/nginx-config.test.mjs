import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const conf = fs.readFileSync(path.join(root, 'nginx.conf'), 'utf8').replace(/\r\n/g, '\n');
const snippet = fs.readFileSync(path.join(root, 'nginx-security-headers.conf'), 'utf8');
const INCLUDE = /include\s+\/etc\/nginx\/snippets\/pc-security-headers\.conf;/;

// Split the server block into its top-level location blocks (no nested braces in this file).
function locations() {
  return [...conf.matchAll(/^\s{4}location\s+([^{]+?)\s*\{([^}]*)\}/gm)].map((m) => ({
    name: m[1],
    body: m[2],
  }));
}

test('security header snippet carries the CSP with script-src self', () => {
  assert.match(snippet, /add_header Content-Security-Policy "[^"]*script-src 'self'[^"]*" always;/);
  for (const header of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Permissions-Policy']) {
    assert.ok(snippet.includes(header), `${header} missing from snippet`);
  }
});

test('nginx.conf includes the snippet at server level and moved the inline headers', () => {
  const serverLevel = conf.split(/^\s{4}location\s/m)[0];
  assert.match(serverLevel, INCLUDE);
  assert.doesNotMatch(conf, /add_header\s+Content-Security-Policy\s/, 'CSP must live only in the snippet');
});

test('every location that sets add_header also includes the snippet', () => {
  const withHeaders = locations().filter((loc) => loc.body.includes('add_header'));
  assert.ok(withHeaders.length >= 4);
  for (const loc of withHeaders) {
    assert.match(loc.body, INCLUDE, `location ${loc.name} must include the security headers`);
  }
});

test('HTML shell, manifest and SPA fallback revalidate; hashed assets stay immutable', () => {
  const byName = Object.fromEntries(locations().map((loc) => [loc.name, loc.body]));
  for (const name of ['= /index.html', '= /manifest.json', '/']) {
    assert.ok(byName[name], `location ${name} missing`);
    assert.match(byName[name], /Cache-Control "no-cache" always;/);
  }
  const assets = locations().find((loc) => loc.name.startsWith('~*'));
  assert.match(assets.body, /public, immutable/);
});
