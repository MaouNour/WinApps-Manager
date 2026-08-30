'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { DOWNLOADS_DIR } = require('./paths');

const VIRTIO_URL = 'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/latest-virtio/virtio-win.iso';

// Product edition IDs on Microsoft's public software-download pages.
const PRODUCT_EDITION = { win11: 3113, win10: 2618 };

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(httpsGet(res.headers.location, headers));
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

function downloadToFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          return resolve(downloadToFile(res.headers.location, destPath, onProgress));
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
          return;
        }
        const total = Number(res.headers['content-length'] || 0);
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress && total) onProgress(received / total);
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(destPath)));
      })
      .on('error', (err) => {
        fs.unlink(destPath, () => reject(err));
      });
  });
}

/** Downloads (or reuses a cached) VirtIO drivers ISO. No user interaction required. */
async function ensureVirtioIso(onProgress) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const dest = path.join(DOWNLOADS_DIR, 'virtio-win.iso');
  if (fs.existsSync(dest) && fs.statSync(dest).size > 100 * 1024 * 1024) {
    if (onProgress) onProgress({ pct: 100, message: 'Using cached VirtIO ISO.' });
    return dest;
  }
  if (onProgress) onProgress({ pct: 0, message: 'Downloading VirtIO driver ISO...' });
  await downloadToFile(VIRTIO_URL, dest, (frac) => onProgress && onProgress({ pct: Math.round(frac * 100), message: 'Downloading VirtIO driver ISO...' }));
  return dest;
}

/**
 * Replicates the public (unauthenticated) request flow Microsoft's own
 * software-download page JS uses to hand out a direct ISO link - the same
 * technique tools like Fido/Rufus's "download Windows ISO" feature use.
 * This is inherently a bit brittle (Microsoft can change/rate-limit these
 * endpoints at any time); callers should catch failures and fall back to
 * letting the user browse for a local ISO.
 */
async function fetchWindowsIsoLinks(edition) {
  const productEditionId = PRODUCT_EDITION[edition];
  if (!productEditionId) throw new Error(`Unknown Windows edition '${edition}'`);

  const sessionId = crypto.randomUUID();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  };
  const segment = edition === 'win11' ? 'windows11' : 'windows10';

  // Step 1: register the session against the SKU endpoint to get language/SKU options.
  const skuUrl = `https://www.microsoft.com/en-us/api/controls/contentinclude/html?pageId=a8f8f489-4c7f-463a-9ca6-5cff94d8d041&host=www.microsoft.com&segments=software-download,${segment}&query=&action=getskuinformationbyproductedition&sessionId=${sessionId}&productEditionId=${productEditionId}&sdVersion=2`;
  const skuHtml = await httpsGet(skuUrl, headers);
  const skuMatch = [...skuHtml.matchAll(/value=&quot;(\d+)&quot;>([^<]+)</g)].map((m) => ({ id: m[1], name: m[2] }));
  const chosenSku = skuMatch.find((s) => /english/i.test(s.name)) || skuMatch[0];
  if (!chosenSku) throw new Error('Could not parse language/SKU options from Microsoft download page (page layout may have changed).');

  // Step 2: request download links for that SKU.
  const linksUrl = `https://www.microsoft.com/en-us/api/controls/contentinclude/html?pageId=6e2a1789-ef16-4f27-a296-74ef7ef5d96b&host=www.microsoft.com&segments=software-download,${segment}&query=&action=GetProductDownloadLinksBySku&sessionId=${sessionId}&skuId=${chosenSku.id}&language=English&sdVersion=2`;
  const linksHtml = await httpsGet(linksUrl, headers);
  const urlMatch = linksHtml.match(/https:\/\/software-download\.microsoft\.com\/[^"']+\.iso[^"'\s]*/);
  if (!urlMatch) {
    if (/we are unable to complete your request/i.test(linksHtml)) {
      throw new Error('Microsoft rate-limited/blocked this download session (happens if requested too often from the same IP in a short window). Try again later, or pick the ISO manually.');
    }
    throw new Error("Could not find a direct ISO link in Microsoft's response (page layout may have changed).");
  }
  return { isoUrl: urlMatch[0], skuName: chosenSku.name };
}

/** Downloads (or reuses a cached) Windows installer ISO. Throws if Microsoft's flow fails - caller should offer manual fallback. */
async function ensureWindowsIso(edition, onProgress) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const dest = path.join(DOWNLOADS_DIR, `windows-${edition}.iso`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 2 * 1024 * 1024 * 1024) {
    if (onProgress) onProgress({ pct: 100, message: 'Using cached Windows ISO.' });
    return dest;
  }
  if (onProgress) onProgress({ pct: 0, message: 'Requesting a Windows ISO download link from Microsoft...' });
  const { isoUrl } = await fetchWindowsIsoLinks(edition);
  if (onProgress) onProgress({ pct: 2, message: 'Downloading Windows ISO (multi-GB file, this takes a while)...' });
  await downloadToFile(isoUrl, dest, (frac) => onProgress && onProgress({ pct: Math.round(frac * 100), message: 'Downloading Windows ISO...' }));
  return dest;
}

module.exports = { ensureVirtioIso, ensureWindowsIso, fetchWindowsIsoLinks };
