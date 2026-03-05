// Index — Content Script
(() => {

  // ── Page metadata ───────────────────────────────────────────────────────────

  function getMeta(name) {
    return document.querySelector(`meta[property="${name}"]`)?.content ||
           document.querySelector(`meta[name="${name}"]`)?.content || '';
  }
  function cleanTitle(t) { return t.replace(/\s*[\|\-–—]\s*[^|\-–—]+$/, '').trim(); }

  function extractPageMetadata() {
    const ogDesc = getMeta('og:description') || getMeta('description') || '';
    const selectors = ['article p', 'main p', '[role="main"] p', '.article-body p', '.post-content p', '.entry-content p', 'p'];
    let firstPara = '';
    for (const sel of selectors) {
      const found = [...document.querySelectorAll(sel)].find(p => p.textContent.trim().length > 80);
      if (found) { firstPara = found.textContent.trim(); break; }
    }
    const page_description = (firstPara.length > ogDesc.length ? firstPara : ogDesc).slice(0, 400);
    return {
      page_title: getMeta('og:title') || cleanTitle(document.title),
      page_url: window.location.href,
      source_url: window.location.href,
      page_description,
    };
  }

  function extractImageContext(imgEl) {
    if (!imgEl) return {};
    const fig = imgEl.closest('figure');
    const cap = fig?.querySelector('figcaption')?.textContent?.trim() || '';
    const nearby = imgEl.parentElement?.querySelector('h1,h2,h3,p')?.textContent?.trim() || '';
    return { alt_text: imgEl.alt || '', surrounding_text: cap || nearby };
  }

  // ── Panel ────────────────────────────────────────────────────────────────────

  let panel = null;
  let panelData = null;
  let panelChannels = [];
  let panelSelected = new Set(); // multi-select: set of slugs
  let panelEditOpen = false;

  function showPanel(data) {
    // Toggle off if icon click while showing a page capture
    if (panel && data?.capture_method === 'page') { hidePanel(); return; }

    panelData = data || {};
    panelSelected = new Set();
    panelEditOpen = false;

    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'idx-panel';
      document.body.appendChild(panel);
    }

    renderPanel();

    if (!panelChannels.length) {
      chrome.runtime.sendMessage({ type: 'GET_CHANNELS' }, (ch) => {
        panelChannels = Array.isArray(ch) ? ch : [];
        renderChannelList(panelChannels);
      });
    } else {
      renderChannelList(panelChannels);
    }
  }

  function hidePanel() {
    panel?.remove();
    panel = null;
    panelData = null;
    panelSelected = new Set();
  }

  function renderPanel() {
    const data = panelData || {};
    const isPage = data.capture_method === 'page';

    panel.innerHTML = `
      <div class="idx-hd">
        <span class="idx-logo">✦</span>
        <span class="idx-hd-title">Connect</span>
        <div class="idx-hd-actions">
          ${isPage ? '<button class="idx-region-btn" id="idx-region-btn" title="Capture region">✂ Region</button>' : ''}
          <button class="idx-close-btn" id="idx-close">×</button>
        </div>
      </div>

      <div class="idx-preview" id="idx-preview">
        <div class="idx-preview-thumb">
          ${data.image_data
            ? `<img src="data:${data.image_type || 'image/jpeg'};base64,${data.image_data}" alt=""/>`
            : '<div class="idx-preview-empty"></div>'}
        </div>
        <div class="idx-preview-meta">
          <span class="idx-preview-title">${esc(data.page_title || '')}</span>
          <span class="idx-preview-url">${esc(shortUrl(data.source_url || data.page_url || ''))}</span>
        </div>
        <button class="idx-edit-btn" id="idx-edit-btn">Edit</button>
      </div>

      <div class="idx-edit-form" id="idx-edit-form" style="display:none">
        <input class="idx-inp" id="idx-edit-title" value="${escAttr(data.page_title || '')}" placeholder="Title"/>
        <input class="idx-inp" id="idx-edit-url" value="${escAttr(data.source_url || data.page_url || '')}" placeholder="Source URL"/>
      </div>

      <div class="idx-search-wrap">
        <input class="idx-search-inp" id="idx-search" type="text" placeholder="Type to search…" autocomplete="off"/>
        <svg class="idx-search-icon" width="13" height="13" viewBox="0 0 13 13" fill="none">
          <circle cx="5.5" cy="5.5" r="4" stroke="currentColor" stroke-width="1.3"/>
          <path d="M8.5 8.5L12 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
        </svg>
      </div>

      <div class="idx-ch-heading">Channels</div>
      <div class="idx-ch-list" id="idx-ch-list">
        <div class="idx-msg">Loading…</div>
      </div>

      <div class="idx-connect-wrap">
        <button class="idx-connect-btn" id="idx-connect" disabled>Connect to 0 channels</button>
      </div>
    `;

    panel.querySelector('#idx-close').onclick = hidePanel;

    panel.querySelector('#idx-edit-btn').onclick = () => {
      panelEditOpen = !panelEditOpen;
      panel.querySelector('#idx-edit-form').style.display = panelEditOpen ? '' : 'none';
      panel.querySelector('#idx-edit-btn').textContent = panelEditOpen ? 'Done' : 'Edit';
    };

    panel.querySelector('#idx-region-btn')?.addEventListener('click', () => {
      hidePanel();
      showOverlay();
    });

    panel.querySelector('#idx-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      renderChannelList(q ? panelChannels.filter(c => c.title.toLowerCase().includes(q)) : panelChannels);
    });

    panel.querySelector('#idx-connect').addEventListener('click', connectToChannels);
  }

  function renderChannelList(channels) {
    const list = panel?.querySelector('#idx-ch-list');
    if (!list) return;
    if (!channels.length) {
      list.innerHTML = '<div class="idx-msg">No channels found</div>';
      return;
    }
    list.innerHTML = channels.map(c => {
      const vis = c.visibility || 'public';
      const count = c.counts?.contents ?? c.length ?? '';
      const owner = c.user?.username || c.user?.full_name || '';
      const selected = panelSelected.has(c.slug);
      return `<div class="idx-ch-row ${vis} ${selected ? 'selected' : ''}"
                   data-slug="${escAttr(c.slug)}" data-title="${escAttr(c.title)}">
        <span class="idx-ch-name">${esc(c.title)}</span>
        ${count !== '' ? `<span class="idx-ch-count">${count}</span>` : ''}
        ${owner ? `<span class="idx-ch-owner">${esc(owner)}</span>` : ''}
      </div>`;
    }).join('');

    list.querySelectorAll('.idx-ch-row').forEach(el => {
      el.addEventListener('click', () => {
        const slug = el.dataset.slug;
        if (panelSelected.has(slug)) { panelSelected.delete(slug); el.classList.remove('selected'); }
        else { panelSelected.add(slug); el.classList.add('selected'); }
        updateConnectBtn();
      });
    });
  }

  function updateConnectBtn() {
    const btn = panel?.querySelector('#idx-connect');
    if (!btn) return;
    const n = panelSelected.size;
    btn.disabled = n === 0;
    btn.textContent = `Connect to ${n} channel${n !== 1 ? 's' : ''}`;
  }

  async function connectToChannels() {
    if (!panelSelected.size) return;
    const btn = panel?.querySelector('#idx-connect');
    if (btn) { btn.disabled = true; btn.textContent = 'Connecting…'; }

    const data = panelData || {};
    const title = panel?.querySelector('#idx-edit-title')?.value ?? data.page_title ?? '';
    const source_url = panel?.querySelector('#idx-edit-url')?.value ?? data.source_url ?? data.page_url ?? '';
    const slugs = [...panelSelected];
    let done = 0;

    for (const slug of slugs) {
      const ch = panelChannels.find(c => c.slug === slug);
      const block = {
        local_id: `local_${Date.now()}_${slug}`,
        title,
        source_url,
        channel_slug: slug,
        channel_title: ch?.title || slug,
        page_title: data.page_title,
        alt_text: data.alt_text,
        surrounding_text: data.surrounding_text,
        image_data: data.image_data,
        image_type: data.image_type,
        capture_method: data.capture_method || 'direct',
      };
      await new Promise(resolve => chrome.runtime.sendMessage({ type: 'PROCESS_CAPTURE', block }, resolve));
      done++;
      if (panel && btn) btn.textContent = `Connecting… ${done}/${slugs.length}`;
    }

    if (panel && btn) btn.textContent = `✓ Connected to ${done} channel${done !== 1 ? 's' : ''}`;
    setTimeout(hidePanel, 1000);
  }

  // ── Region overlay ──────────────────────────────────────────────────────────

  let overlay = null;

  function showOverlay() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'idx-overlay';
      overlay.innerHTML = '<div class="idx-hint">Drag to select · Esc to cancel</div>';
      document.body.appendChild(overlay);

      let sx, sy, sel;
      overlay.addEventListener('mousedown', e => {
        sx = e.clientX; sy = e.clientY;
        sel = document.createElement('div');
        sel.id = 'idx-sel';
        overlay.appendChild(sel);
      });
      overlay.addEventListener('mousemove', e => {
        if (!sel) return;
        const x = Math.min(e.clientX, sx), y = Math.min(e.clientY, sy);
        Object.assign(sel.style, { left: x+'px', top: y+'px', width: Math.abs(e.clientX-sx)+'px', height: Math.abs(e.clientY-sy)+'px' });
      });
      overlay.addEventListener('mouseup', e => {
        if (!sel) return;
        const r = { x: parseInt(sel.style.left), y: parseInt(sel.style.top), w: parseInt(sel.style.width), h: parseInt(sel.style.height) };
        sel.remove(); sel = null;
        if (r.w > 10 && r.h > 10) doCapture(r);
        else hideOverlay();
      });
    }
    overlay.classList.add('active');
    document.body.style.cursor = 'crosshair';
    document.addEventListener('keydown', onEsc);
  }

  function hideOverlay() {
    overlay?.classList.remove('active');
    document.body.style.cursor = '';
    document.removeEventListener('keydown', onEsc);
  }

  function onEsc(e) { if (e.key === 'Escape') { hideOverlay(); hidePanel(); } }

  function doCapture(rect) {
    const meta = extractPageMetadata();
    hideOverlay();
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_REGION', rect }, (res) => {
        if (chrome.runtime.lastError || !res?.imageData) return;
        cropImage(res.imageData, rect).then(cropped => {
          showPanel({ image_data: cropped, image_type: 'image/jpeg', capture_method: 'region', ...meta });
        });
      });
    }, 80);
  }

  function cropImage(base64, rect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const dpr = window.devicePixelRatio || 1;
        const canvas = document.createElement('canvas');
        canvas.width = rect.w * dpr; canvas.height = rect.h * dpr;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, rect.x*dpr, rect.y*dpr, rect.w*dpr, rect.h*dpr, 0, 0, rect.w*dpr, rect.h*dpr);
        resolve(canvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
      };
      img.src = 'data:image/jpeg;base64,' + base64;
    });
  }

  // ── Message handler ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') { sendResponse({ ok: true }); return false; }

    if (msg.type === 'GET_PAGE_METADATA') { sendResponse(extractPageMetadata()); return false; }

    if (msg.type === 'SHOW_PANEL') {
      showPanel(msg.data);
      sendResponse({ ok: true }); return false;
    }
    if (msg.type === 'SHOW_MAIN_PANEL') {
      showPanel({ capture_method: 'page' });
      sendResponse({ ok: true }); return false;
    }
    if (msg.type === 'SHOW_OVERLAY') {
      showOverlay();
      sendResponse({ ok: true }); return false;
    }
    if (msg.type === 'CONTEXT_MENU_CAPTURE') {
      const imgEl = [...document.querySelectorAll('img')].find(i => i.src === msg.imageUrl || i.currentSrc === msg.imageUrl);
      const ctx = extractImageContext(imgEl);
      const meta = extractPageMetadata();
      const instagramUrl = getInstagramPostUrl(imgEl);
      const imageData = {
        image_type: 'image/jpeg', image_data: '',
        capture_method: 'direct',
        page_title: cleanTitle(msg.pageTitle || document.title),
        page_url: msg.pageUrl,
        ...ctx, ...meta,
        source_url: instagramUrl || msg.imageUrl,
      };
      chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url: msg.imageUrl }, (res) => {
        if (!chrome.runtime.lastError && res?.base64) {
          imageData.image_data = res.base64;
          imageData.image_type = res.mimeType;
        }
        showPanel(imageData);
      });
      return false;
    }
  });

  // ── Context menu: store image URL on right-click ─────────────────────────────

  document.addEventListener('contextmenu', (e) => {
    try {
      let img = e.target.closest('img');
      if (!img) {
        const el = e.target;
        const prev = el.style.pointerEvents;
        el.style.pointerEvents = 'none';
        const under = document.elementFromPoint(e.clientX, e.clientY);
        el.style.pointerEvents = prev;
        img = under?.tagName === 'IMG' ? under : under?.closest('img');
      }
      if (img?.src) chrome.runtime.sendMessage({ type: 'STORE_CONTEXT_IMAGE', srcUrl: img.src, pageUrl: location.href });
    } catch { }
  });

  // ── Instagram post URL ───────────────────────────────────────────────────────

  function getInstagramPostUrl(imgEl) {
    if (!location.hostname.includes('instagram.com')) return null;
    let node = imgEl?.parentElement;
    while (node && node !== document.body) {
      if (node.tagName === 'A' && /\/(p|reel|tv)\/[^/]+/.test(node.href)) return node.href;
      node = node.parentElement;
    }
    const article = imgEl?.closest('article');
    if (article) {
      const link = article.querySelector('a[href*="/p/"],a[href*="/reel/"],a[href*="/tv/"]');
      if (link) return link.href;
    }
    return null;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function shortUrl(url) {
    try { const u = new URL(url); return u.hostname.replace('www.', '') + (u.pathname !== '/' ? u.pathname : ''); }
    catch { return url; }
  }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escAttr(s) { return String(s).replace(/"/g,'&quot;').replace(/</g,'&lt;'); }

})();
