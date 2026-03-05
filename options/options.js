// Index — Options
// All Are.na API calls go through background worker to avoid CORS issues

async function load() {
  const { arena_token, anthropic_token, default_channel } =
    await chrome.storage.sync.get(['arena_token', 'anthropic_token', 'default_channel']);

  if (arena_token) document.getElementById('arena-token').value = arena_token;
  if (anthropic_token) document.getElementById('anthropic-token').value = anthropic_token;

  if (arena_token) {
    await populateChannels(default_channel);
  }
}

async function populateChannels(selectedSlug) {
  const select = document.getElementById('default-channel');
  select.innerHTML = '<option value="">Loading…</option>';

  try {
    // Route through background worker — it has the token and handles CORS
    const channels = await chrome.runtime.sendMessage({ type: 'GET_CHANNELS' });

    if (!channels || channels.error) {
      select.innerHTML = `<option value="">Error: ${channels?.error || 'unknown'} — check token</option>`;
      return;
    }

    if (!channels.length) {
      select.innerHTML = '<option value="">No channels found</option>';
      return;
    }

    select.innerHTML =
      '<option value="">— no default —</option>' +
      channels
        .map(c => `<option value="${c.slug}" ${c.slug === selectedSlug ? 'selected' : ''}>${c.title}</option>`)
        .join('');

  } catch (err) {
    select.innerHTML = `<option value="">Failed to load — is the extension active?</option>`;
    console.error('Channel load error:', err);
  }
}

// Save
document.getElementById('save').addEventListener('click', async () => {
  const arena_token = document.getElementById('arena-token').value.trim();
  const anthropic_token = document.getElementById('anthropic-token').value.trim();
  const default_channel = document.getElementById('default-channel').value;
  const status = document.getElementById('status');

  if (!arena_token || !anthropic_token) {
    status.textContent = 'Both API keys are required';
    status.style.color = 'rgba(255,100,100,0.8)';
    setTimeout(() => { status.textContent = ''; }, 2500);
    return;
  }

  await chrome.storage.sync.set({ arena_token, anthropic_token, default_channel });
  status.textContent = 'Saved ✓';
  status.style.color = 'rgba(255,255,255,0.45)';
  setTimeout(() => { status.textContent = ''; }, 2000);
});

// Fetch channels button — saves token first, then fetches
document.getElementById('fetch-channels').addEventListener('click', async () => {
  const arena_token = document.getElementById('arena-token').value.trim();
  const status = document.getElementById('status');

  if (!arena_token) {
    status.textContent = 'Enter your Are.na token first';
    status.style.color = 'rgba(255,100,100,0.8)';
    setTimeout(() => { status.textContent = ''; }, 2000);
    return;
  }

  // Temporarily save token so the background worker can use it for the fetch
  await chrome.storage.sync.set({ arena_token });
  await populateChannels('');
});

load();

// Debug helper — shows what keys are actually stored
document.addEventListener('keydown', (e) => {
  if (e.key === 'd' && e.metaKey && e.shiftKey) {
    chrome.runtime.sendMessage({ type: 'DEBUG_TOKENS' }, (res) => {
      alert('Stored tokens:\n' + JSON.stringify(res, null, 2));
    });
  }
});
