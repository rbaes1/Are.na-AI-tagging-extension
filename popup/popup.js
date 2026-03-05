// Index — Popup

let allChannels = [];
let selectedChannel = null;

async function init() {
  const { arena_token, anthropic_token } = await chrome.storage.sync.get(['arena_token', 'anthropic_token']);
  const hasTokens = !!(arena_token && anthropic_token);

  document.getElementById('no-token').classList.toggle('hidden', hasTokens);
  document.getElementById('main').classList.toggle('hidden', !hasTokens);

  if (!hasTokens) return;

  loadQueue();
  loadChannels();
}

// ── Channels ──────────────────────────────────────────────────────────────────

async function loadChannels() {
  const list = document.getElementById('channel-list');
  list.innerHTML = '<div class="list-loading">Loading channels…</div>';

  chrome.runtime.sendMessage({ type: 'GET_CHANNELS' }, (channels) => {
    if (chrome.runtime.lastError) {
      list.innerHTML = `<div class="list-error">Error: ${chrome.runtime.lastError.message}</div>`;
      return;
    }
    if (!channels || channels.error) {
      list.innerHTML = `<div class="list-error">${channels?.error || 'Failed'}<br><small>Check Are.na token in settings</small></div>`;
      return;
    }
    if (!Array.isArray(channels) || !channels.length) {
      list.innerHTML = '<div class="list-empty">No channels found</div>';
      return;
    }
    allChannels = channels;
    renderChannels(channels);
  });
}

function renderChannels(channels) {
  const list = document.getElementById('channel-list');
  if (!channels.length) {
    list.innerHTML = '<div class="list-empty">No channels match</div>';
    return;
  }
  list.innerHTML = channels.map(c => `
    <div class="channel-item ${selectedChannel?.slug === c.slug ? 'selected' : ''}"
         data-slug="${escAttr(c.slug)}" data-title="${escAttr(c.title)}"
         data-id="${c.id || ''}">
      <div class="channel-item-left">
        <div class="channel-dot ${c.visibility || 'public'}"></div>
        <span class="channel-name">${esc(c.title)}</span>
      </div>
      <span class="channel-count">${c.counts?.contents ?? ''}</span>
    </div>
  `).join('');

  list.querySelectorAll('.channel-item').forEach(el => {
    el.addEventListener('click', () => {
      const ch = allChannels.find(c => c.slug === el.dataset.slug);
      if (ch) selectChannel(ch);
    });
  });
}

function selectChannel(channel) {
  selectedChannel = channel;
  document.getElementById('capture-bar').classList.remove('hidden');
  document.getElementById('selected-channel-name').textContent = channel.title;
  document.querySelectorAll('.channel-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.slug === channel.slug);
  });
}

function deselectChannel() {
  selectedChannel = null;
  document.getElementById('capture-bar').classList.add('hidden');
  document.querySelectorAll('.channel-item').forEach(el => el.classList.remove('selected'));
}

// ── Search ────────────────────────────────────────────────────────────────────

document.getElementById('channel-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  renderChannels(q ? allChannels.filter(c => c.title.toLowerCase().includes(q)) : allChannels);
});

// ── Capture: Region screenshot ────────────────────────────────────────────────

document.getElementById('btn-screenshot').addEventListener('click', async () => {
  if (!selectedChannel) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  try {
    await ensureContentScript(tab.id);
    // Pass channel directly in the message — no storage race condition
    await sendTabMessage(tab.id, { type: 'SHOW_OVERLAY', channel: selectedChannel });
    window.close();
  } catch (err) {
    console.error('Could not show overlay:', err);
  }
});

// ── Capture: Full page ────────────────────────────────────────────────────────

document.getElementById('btn-page').addEventListener('click', async () => {
  if (!selectedChannel) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  try {
    // Capture screenshot — must happen before window.close()
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 85 });
    const base64 = dataUrl.split(',')[1];

    await ensureContentScript(tab.id);

    // Get metadata
    let meta = { page_title: tab.title, page_url: tab.url, source_url: tab.url };
    try {
      const m = await sendTabMessage(tab.id, { type: 'GET_PAGE_METADATA' });
      if (m) meta = m;
    } catch (e) { /* use tab fallback */ }

    // Send capture data directly in message (avoid storage race)
    await sendTabMessage(tab.id, {
      type: 'SHOW_CAPTURE_POPUP',
      data: {
        image_data: base64,
        image_type: 'image/jpeg',
        capture_method: 'page',
        channel_slug: selectedChannel.slug,
        channel_title: selectedChannel.title,
        ...meta,
      }
    });

    window.close();
  } catch (err) {
    console.error('Page capture failed:', err);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureContentScript(tabId) {
  try {
    await sendTabMessage(tabId, { type: 'PING' });
  } catch (e) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
    await new Promise(r => setTimeout(r, 150));
  }
}

function sendTabMessage(tabId, msg) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function escAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

// ── Events ────────────────────────────────────────────────────────────────────

document.getElementById('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('go-settings')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('deselect-channel').addEventListener('click', deselectChannel);
document.getElementById('flush-queue')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'FLUSH_QUEUE' }, loadQueue);
});

async function loadQueue() {
  const { queue = [] } = await chrome.storage.local.get('queue');
  document.getElementById('queue-count').textContent = queue.length;
  document.getElementById('queue-row').classList.toggle('hidden', queue.length === 0);
}

init();
