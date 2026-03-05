// Index — Background Service Worker
const ARENA_API = 'https://api.are.na/v3';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// ── Storage ───────────────────────────────────────────────────────────────────

async function getQueue() {
  const { queue = [] } = await chrome.storage.local.get('queue');
  return queue;
}
async function addToQueue(block) {
  const queue = await getQueue();
  queue.push({ ...block, queued_at: new Date().toISOString() });
  await chrome.storage.local.set({ queue });
}
async function removeFromQueue(id) {
  const queue = await getQueue();
  await chrome.storage.local.set({ queue: queue.filter(b => b.local_id !== id) });
}
async function addToRecent(entry) {
  const { recent = [] } = await chrome.storage.local.get('recent');
  recent.unshift(entry);
  await chrome.storage.local.set({ recent: recent.slice(0, 20) });
}

// ── Are.na API ────────────────────────────────────────────────────────────────

async function arenaFetch(path, options = {}) {
  const { arena_token } = await chrome.storage.sync.get('arena_token');
  if (!arena_token) throw new Error('No Are.na token — open Settings and save your token');

  const headers = { 'Authorization': `Bearer ${arena_token}` };
  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${ARENA_API}${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.details?.message || err.error || `Are.na error ${res.status}`);
  }
  return res.json();
}

async function fetchChannels() {
  const user = await arenaFetch('/me');
  const data = await arenaFetch(`/users/${user.slug}/contents?type=Channel&per=100&sort=updated_at_desc`);
  return (data.data || []).filter(item => item.type === 'Channel');
}

async function pushBlockToArena(block) {
  const description = buildArenaDescription(block);
  let value;

  if (block.image_data) {
    const ext = block.image_type === 'image/png' ? 'png' : 'jpg';
    const presignRes = await arenaFetch('/uploads/presign', {
      method: 'POST',
      body: JSON.stringify({
        files: [{ filename: `capture.${ext}`, content_type: block.image_type || 'image/jpeg' }],
      }),
    });
    const { upload_url, key } = presignRes.files[0];

    const blob = base64ToBlob(block.image_data, block.image_type || 'image/jpeg');
    const s3Res = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': block.image_type || 'image/jpeg' },
      body: blob,
    });
    if (!s3Res.ok) throw new Error(`S3 upload failed: ${s3Res.status}`);
    value = `https://s3.amazonaws.com/arena_images-temp/${key}`;

  } else if (block.source_url) {
    value = block.source_url;
  } else {
    throw new Error('Block has no image or source URL');
  }

  const channelData = await arenaFetch(`/channels/${block.channel_slug}`);
  const channelId = channelData.id;

  return arenaFetch('/blocks', {
    method: 'POST',
    body: JSON.stringify({
      value,
      title: block.title || block.page_title || '',
      description,
      original_source_url: block.source_url || '',
      original_source_title: block.page_title || '',
      channel_ids: [channelId],
    }),
  });
}

function buildArenaDescription(block) {
  const lines = [];

  if (block.tags?.length) {
    lines.push('tags:');
    lines.push(block.tags.join(', '));
    lines.push('');
  }

  if (block.description) {
    lines.push('description:');
    lines.push(block.description);
    lines.push('');
  }

  if (block.source_url) {
    lines.push('source:');
    lines.push(block.source_url);
    lines.push('');
  }

  if (block.page_title) {
    lines.push('page title:');
    lines.push(block.page_title);
    lines.push('');
  }

  lines.push('captured:');
  lines.push(new Date().toISOString().split('T')[0]);

  return lines.join('\n');
}

// ── Claude Vision Tagging ─────────────────────────────────────────────────────

async function tagWithClaude(block) {
  const { anthropic_token } = await chrome.storage.sync.get('anthropic_token');
  if (!anthropic_token) throw new Error('No Anthropic token — open Settings and save your key');
  if (!anthropic_token.startsWith('sk-ant-')) {
    throw new Error(`Anthropic key looks wrong. Got: ${anthropic_token.slice(0, 10)}...`);
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': anthropic_token,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };

  // If page has text, use it as description — only ask Claude for tags (text-only = cheap)
  const pageText = block.page_description || block.surrounding_text || '';
  const hasPageText = pageText.length > 60;

  if (hasPageText) {
    const context = [
      block.page_title && `Title: ${block.page_title}`,
      `Text: ${pageText}`,
      block.alt_text && `Alt: ${block.alt_text}`,
    ].filter(Boolean).join('\n');

    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: `Rewrite the following in 1 concise sentence, then generate 5-10 retrieval tags (subject, materials, typology, mood, visual qualities).\n\n${context}\n\nJSON only:\n{"description": "1 sentence here", "tags": ["tag1", "tag2"]}` }],
      }),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`Claude API error ${res.status}: ${e.error?.message || JSON.stringify(e)}`);
    }
    const data = await res.json();
    return JSON.parse(data.content[0].text.replace(/```json|```/g, '').trim());
  }

  // No page text — vision call: 1 sentence + tags
  const context = [
    block.page_title && `Title: ${block.page_title}`,
    block.alt_text && `Alt: ${block.alt_text}`,
  ].filter(Boolean).join('\n');

  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: block.image_type || 'image/jpeg', data: block.image_data } },
          { type: 'text', text: `Describe this image in exactly 1 sentence, then give 5-10 retrieval tags (materials, typology, mood, scale, light).${context ? '\n\nContext:\n' + context : ''}\n\nJSON only:\n{"description": "...", "tags": ["tag1", "tag2"]}` },
        ],
      }],
    }),
  });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Claude API error ${res.status}: ${e.error?.message || JSON.stringify(e)}`);
  }
  const data = await res.json();
  return JSON.parse(data.content[0].text.replace(/```json|```/g, '').trim());
}

// ── Capture pipeline ──────────────────────────────────────────────────────────

async function processCapture(block) {
  try {
    console.log('Processing capture for channel:', block.channel_slug);
    const { description, tags } = await tagWithClaude(block);
    block.description = description;
    block.tags = tags;
    console.log('Tagged:', tags);

    const arenaBlock = await pushBlockToArena(block);
    console.log('Saved to Are.na block ID:', arenaBlock.id);

    await addToRecent({
      local_id: block.local_id,
      arena_block_id: arenaBlock.id,
      title: block.title || block.page_title || 'Untitled',
      channel_slug: block.channel_slug,
      thumb: arenaBlock.image?.small?.src || null,
      status: 'done',
      saved_at: new Date().toISOString(),
    });

    return { success: true };
  } catch (err) {
    console.error('Capture failed:', err.message);
    await addToQueue(block);
    return { success: false, queued: true, error: err.message };
  }
}

async function flushQueue() {
  const queue = await getQueue();
  for (const block of queue) {
    try {
      const { description, tags } = await tagWithClaude(block);
      block.description = description;
      block.tags = tags;
      await pushBlockToArena(block);
      await removeFromQueue(block.local_id);
    } catch (err) {
      console.error(`Flush failed ${block.local_id}:`, err.message);
    }
  }
}

// ── Fetch remote image (bypasses CORS for content scripts) ────────────────────

async function fetchRemoteImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image fetch failed: ${res.status}`);
  const blob = await res.blob();
  const arrayBuf = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  const mimeType = blob.type || 'image/jpeg';
  return { base64, mimeType };
}

// ── Content script injection ───────────────────────────────────────────────────

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
    await new Promise(r => setTimeout(r, 150));
  }
}

// ── Extension icon click ──────────────────────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await ensureContentScript(tab.id);

    // Capture screenshot first, then show panel
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
    const image_data = dataUrl.split(',')[1];

    let meta = { page_title: tab.title, page_url: tab.url, source_url: tab.url };
    try {
      meta = await new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_METADATA' }, (res) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(res || meta);
        });
      });
    } catch (e) {}

    chrome.tabs.sendMessage(tab.id, {
      type: 'SHOW_PANEL',
      data: { image_data, image_type: 'image/jpeg', capture_method: 'page', ...meta },
    });
  } catch (err) {
    console.error('Action click failed:', err);
  }
});

// ── Context menu ──────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'save-image-to-index',
    title: 'Save image to Index',
    contexts: ['image', 'all'],
  });
});

let storedContextImage = null;

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'save-image-to-index') return;
  try {
    await ensureContentScript(tab.id);
    const imageUrl = info.srcUrl || storedContextImage?.srcUrl;
    if (imageUrl) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'CONTEXT_MENU_CAPTURE',
        imageUrl,
        pageUrl: tab.url,
        pageTitle: tab.title,
      });
    }
  } catch (err) {
    console.error('Context menu failed:', err);
  }
});

// ── Message handler ───────────────────────────────────────────────────────────

function keepAlive() {
  const id = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  return () => clearInterval(id);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'STORE_CONTEXT_IMAGE') {
    storedContextImage = { srcUrl: msg.srcUrl, pageUrl: msg.pageUrl };
    return false;
  }

  if (msg.type === 'GET_CHANNELS') {
    const stop = keepAlive();
    fetchChannels()
      .then(ch => { stop(); sendResponse(ch); })
      .catch(err => { stop(); sendResponse({ error: err.message }); });
    return true;
  }

  if (msg.type === 'PROCESS_CAPTURE') {
    const stop = keepAlive();
    processCapture(msg.block)
      .then(r => { stop(); sendResponse(r); })
      .catch(err => { stop(); sendResponse({ error: err.message }); });
    return true;
  }

  if (msg.type === 'CAPTURE_REGION') {
    const stop = keepAlive();
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        // Wait two frames for the overlay to fully disappear before screenshotting
        await new Promise(r => setTimeout(r, 80));
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 88 });
        stop();
        sendResponse({ imageData: dataUrl.split(',')[1] });
      } catch (err) {
        stop();
        sendResponse({ error: err.message });
      }
    })();
    return true;
  }

  // Content scripts can't fetch cross-origin images — worker does it instead
  if (msg.type === 'FETCH_IMAGE') {
    const stop = keepAlive();
    fetchRemoteImage(msg.url)
      .then(({ base64, mimeType }) => { stop(); sendResponse({ base64, mimeType }); })
      .catch(err => { stop(); sendResponse({ error: err.message }); });
    return true;
  }

  if (msg.type === 'FLUSH_QUEUE') {
    const stop = keepAlive();
    flushQueue()
      .then(() => { stop(); sendResponse({ ok: true }); })
      .catch(err => { stop(); sendResponse({ error: err.message }); });
    return true;
  }

  // Debug: check what tokens are stored
  if (msg.type === 'DEBUG_TOKENS') {
    chrome.storage.sync.get(['arena_token', 'anthropic_token'], (result) => {
      sendResponse({
        arena_token: result.arena_token ? result.arena_token.slice(0, 15) + '…' : 'NOT SET',
        anthropic_token: result.anthropic_token ? result.anthropic_token.slice(0, 15) + '…' : 'NOT SET',
      });
    });
    return true;
  }

});

// ── Helpers ───────────────────────────────────────────────────────────────────

function base64ToBlob(base64, mimeType) {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mimeType });
}

self.addEventListener('online', flushQueue);
