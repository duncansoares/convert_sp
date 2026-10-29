import { startServer } from '../dist/server/app.js';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { app, url, token } = await startServer({ port: 4399, token: 'smoke-token' });
const headers = { 'x-convert-sp-token': token };

const info = await fetch('http://127.0.0.1:4399/api/info', { headers }).then((r) => r.json());
const profiles = await fetch('http://127.0.0.1:4399/api/profiles', { headers }).then((r) => r.json());
const unauthorized = await fetch('http://127.0.0.1:4399/api/info');
const page = await fetch('http://127.0.0.1:4399/').then((r) => r.text());
const listing = await fetch('http://127.0.0.1:4399/api/fs/list', { headers }).then((r) => r.json());

// Echo the page back: a token in the query string must become a cookie.
const pageWithToken = await fetch('http://127.0.0.1:4399/?token=smoke-token');
const cookie = pageWithToken.headers.getSetCookie?.()[0] ?? pageWithToken.headers.get('set-cookie');

const buildDir = new URL('../web/dist/browser/', import.meta.url);
let built = true;
try {
  await stat(fileURLToPath(buildDir));
} catch {
  built = false;
}
let assetStatus = null;
if (built) {
  const asset = /((?:main|polyfills)-[A-Z0-9]+\.js)/i.exec(page);
  if (asset) {
    assetStatus = (await fetch(`http://127.0.0.1:4399/${asset[1]}`)).status;
  }
}

console.log('url:', url);
console.log('info:', info);
console.log('profiles:', profiles.profiles.length, 'settings:', JSON.stringify(profiles.settings));
console.log('unauthorized status:', unauthorized.status);
console.log('daily page source:', built ? 'angular build' : 'fallback');
console.log('page bytes:', page.length, 'title:', /<title>(.*?)<\/title>/.exec(page)?.[1]);
console.log('token cookie set:', Boolean(cookie && cookie.includes('convert_sp_token')));
console.log('asset status:', assetStatus);
console.log('fs roots:', (listing.roots ?? []).join(', '));
console.log('fs path:', listing.path, 'dirs:', listing.directories.length);

await app.close();

