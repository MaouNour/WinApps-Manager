'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { DOWNLOADS_DIR } = require('./paths');

const VIRTIO_URL = 'https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/latest-virtio/virtio-win.iso';

// Product edition IDs on Microsoft's public consumer software-download
// pages. Note: this flow hands out ONE multi-edition ISO per Windows
// version (setup picks Home/Pro/Education based on the license key entered
// later) - there's no separate "Home ISO" vs "Pro ISO" here.
const CONSUMER_PRODUCT_EDITION = { win11: 3113, win10: 2618 };

// Microsoft Evaluation Center pages for Enterprise/LTSC/IoT/Server SKUs.
// These are real, licensable (90-day eval, re-armable / convertible with a
// volume license key) ISOs Microsoft hands out publicly, but through a
// less scriptable flow than the consumer page (sometimes an email-gated
// form rather than the SKU/session API used below). We try to scrape a
// direct link; if that fails we hand back the eval-center page itself so
// the user is one click away instead of hunting for it.
const EVALCENTER_PAGES = {
  'win11-enterprise': 'https://www.microsoft.com/en-us/evalcenter/download-windows-11-enterprise',
  'win10-enterprise': 'https://www.microsoft.com/en-us/evalcenter/download-windows-10-enterprise',
  'win11-ltsc-iot': 'https://www.microsoft.com/en-us/evalcenter/download-windows-11-iot-enterprise-ltsc-eval',
  'win10-ltsc-iot': 'https://www.microsoft.com/en-us/evalcenter/download-windows-10-iot-enterprise-ltsc',
  server2025: 'https://www.microsoft.com/en-us/evalcenter/download-windows-server-2025',
  server2022: 'https://www.microsoft.com/en-us/evalcenter/download-windows-server-2022'
};

/**
 * Full edition catalogue for the wizard dropdown. `kind`:
 *  - 'consumer'   -> fully automatic via fetchWindowsIsoLinks()
 *  - 'evalcenter' -> best-effort scrape of the eval-center page; falls back
 *                    to handing the user the page link if scraping fails
 *  - 'manual'     -> genuinely not obtainable through an anonymous public
 *                    flow (needs Volume Licensing / a Visual Studio
 *                    subscription / IoT partner login) - said plainly
 *                    instead of pretending to automate it
 */
const EDITIONS = [
  { id: 'win11', label: 'Windows 11 (Home/Pro/Education, retail ISO)', kind: 'consumer', consumerKey: 'win11' },
  { id: 'win10', label: 'Windows 10 (Home/Pro/Education, retail ISO)', kind: 'consumer', consumerKey: 'win10' },
  { id: 'win11-enterprise', label: 'Windows 11 Enterprise (90-day evaluation)', kind: 'evalcenter' },
  { id: 'win10-enterprise', label: 'Windows 10 Enterprise (90-day evaluation)', kind: 'evalcenter' },
  { id: 'win11-ltsc-iot', label: 'Windows 11 IoT Enterprise LTSC (evaluation)', kind: 'evalcenter' },
  { id: 'win10-ltsc-iot', label: 'Windows 10 IoT Enterprise LTSC 2021 (evaluation)', kind: 'evalcenter' },
  {
    id: 'win10-ltsc',
    label: 'Windows 10 Enterprise LTSC 2021 (VLSC only)',
    kind: 'manual',
    note: 'Only distributed via the Volume Licensing Service Center (VLSC) or a Visual Studio/MSDN subscription - there is no anonymous public download. Sign in and download the ISO yourself, then use "Advanced: use my own ISO files" below.'
  },
  { id: 'server2022', label: 'Windows Server 2022 (evaluation)', kind: 'evalcenter' },
  { id: 'server2025', label: 'Windows Server 2025 (evaluation)', kind: 'evalcenter' }
];

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
 * consumer software-download page JS uses to hand out a direct ISO link -
 * the same technique tools like Fido/Rufus's "download Windows ISO" feature
 * use. Only valid for EDITIONS entries with kind: 'consumer'.
 */
async function fetchWindowsIsoLinks(consumerKey) {
  const productEditionId = CONSUMER_PRODUCT_EDITION[consumerKey];
  if (!productEditionId) throw new Error(`Unknown consumer edition '${consumerKey}'`);

  const sessionId = crypto.randomUUID();
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  };
  const segment = consumerKey === 'win11' ? 'windows11' : 'windows10';

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

/**
 * Best-effort scrape of a Microsoft Evaluation Center page for a direct
 * .iso link. These pages are more likely to be email-gated or JS-rendered
 * than the consumer flow, so this is explicitly allowed to fail - callers
 * must catch it and fall back to handing the user the page URL.
 */
async function fetchEvalCenterIsoLink(editionId) {
  const pageUrl = EVALCENTER_PAGES[editionId];
  if (!pageUrl) throw new Error(`No eval-center page known for '${editionId}'`);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  };
  const html = await httpsGet(pageUrl, headers);
  const direct = html.match(/https:\/\/[^"'\s]+\.iso(?:\?[^"'\s]*)?/i);
  if (direct) return { isoUrl: direct[0], pageUrl };
  throw new Error(`Microsoft's evaluation page didn't expose a direct link automatically (it likely requires filling in a form/email). Open ${pageUrl} manually, download the ISO, then use "Advanced: use my own ISO files".`);
}

/** Downloads (or reuses a cached) Windows installer ISO for any EDITIONS entry. Throws with an actionable message on 'manual' editions or scrape failures - caller should offer the manual-ISO fallback. */
async function ensureWindowsIso(editionId, onProgress) {
  const edition = EDITIONS.find((e) => e.id === editionId) || (CONSUMER_PRODUCT_EDITION[editionId] ? { id: editionId, kind: 'consumer', consumerKey: editionId, label: editionId } : null);
  if (!edition) throw new Error(`Unknown Windows edition '${editionId}'`);

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const dest = path.join(DOWNLOADS_DIR, `windows-${editionId}.iso`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 2 * 1024 * 1024 * 1024) {
    if (onProgress) onProgress({ pct: 100, message: 'Using cached Windows ISO.' });
    return dest;
  }

  if (edition.kind === 'manual') {
    throw new Error(edition.note || `${edition.label} has no anonymous public download - pick the ISO manually.`);
  }

  if (onProgress) onProgress({ pct: 0, message: `Requesting a ${edition.label || editionId} download link from Microsoft...` });
  const { isoUrl } = edition.kind === 'consumer'
    ? await fetchWindowsIsoLinks(edition.consumerKey)
    : await fetchEvalCenterIsoLink(edition.id);

  if (onProgress) onProgress({ pct: 2, message: 'Downloading Windows ISO (multi-GB file, this takes a while)...' });
  await downloadToFile(isoUrl, dest, (frac) => onProgress && onProgress({ pct: Math.round(frac * 100), message: 'Downloading Windows ISO...' }));
  return dest;
}

module.exports = { ensureVirtioIso, ensureWindowsIso, fetchWindowsIsoLinks, fetchEvalCenterIsoLink, EDITIONS };
