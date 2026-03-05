# Are.na AI Tagging Extension

A Chrome extension that captures images and web pages directly to your [Are.na](https://www.are.na) channels — with automatic AI-powered tagging and descriptions using Claude.

## Features

- **One-click capture** — click the extension icon to capture the current page as a screenshot
- **Right-click any image** — save images directly to Are.na via the context menu
- **Region selection** — select a specific area of the page to capture
- **AI tagging** — automatically generates a 1-sentence description and 5–10 retrieval tags using Claude (Haiku)
- **Smart analysis** — uses page text when available (fast & cheap), falls back to vision analysis for image-only pages
- **Offline queue** — failed uploads are queued and retried automatically when you're back online
- **Recent captures** — view your last 20 saved blocks in the popup

## Requirements

- [Are.na](https://www.are.na) account + API token
- [Anthropic](https://www.anthropic.com) API key (for AI tagging)

## Installation

Since this extension is not published to the Chrome Web Store, install it manually:

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `index-extension` folder
5. The extension icon will appear in your toolbar

## Setup

1. Click the extension icon and open **Settings** (or right-click → Options)
2. Paste your **Are.na API token** — find it at [dev.are.na](https://dev.are.na)
3. Paste your **Anthropic API key** — find it at [console.anthropic.com](https://console.anthropic.com)
4. Save — you're ready to capture

## Usage

| Action | How |
|--------|-----|
| Capture full page | Click the extension icon |
| Save a specific image | Right-click image → *Save image to Index* |
| Select a region | Use the region selector from the popup |
| Choose channel | Pick from your Are.na channels in the popup before saving |

## Project Structure

```
index-extension/
├── manifest.json
├── background/
│   └── worker.js         # Service worker: Are.na API, Claude API, queue
├── content/
│   ├── content.js        # Page interaction, capture UI overlay
│   └── content.css
├── popup/
│   ├── popup.html
│   ├── popup.js          # Channel picker, recent captures
│   └── popup.css
├── options/
│   ├── options.html
│   ├── options.js        # Token settings
│   └── options.css
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## How AI Tagging Works

When you capture something, the extension sends it to Claude Haiku:

- **If the page has text** (title, description, surrounding text) → text-only API call, fast and low cost
- **If no text is available** → vision call with the captured image

Claude returns a JSON object with a `description` (1 sentence) and `tags` (5–10 keywords covering subject, materials, typology, mood, and visual qualities). These are saved directly into the Are.na block description.

## License

MIT
