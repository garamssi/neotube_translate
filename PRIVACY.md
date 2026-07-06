# Privacy Policy — YouTube AI Subtitle Translator

_Last updated: July 6, 2026_

YouTube AI Subtitle Translator ("the extension") is designed to work entirely on your device,
using translation engines that **you** configure and control.

## What the extension does NOT do

- No analytics, telemetry, or tracking of any kind.
- No data is sent to the extension developer or any third-party server operated by the developer.
- No personal information, browsing history, or account data is collected.

## Data the extension handles

| Data | Where it goes | Why |
|---|---|---|
| Extension settings (language, display options, engine choice) | Stored locally in Chrome extension storage (`chrome.storage.local`) | Remember your preferences |
| Gemini API key (optional, user-provided) | Stored locally in Chrome extension storage; sent **only** to Google's Gemini API (`generativelanguage.googleapis.com`) as an authentication header | Authenticate your own API requests |
| YouTube caption text of the video you choose to translate | Sent **only** to the translation engine you configured: your own local Claude CLI server (`localhost` or an address you set), or Google's Gemini API | Perform the translation/summary you requested |
| Video URL (Gemini summary mode only) | Sent to Google's Gemini API | Let Gemini analyze the public video for summarization |
| Translation & summary results | Cached locally in Chrome extension storage | Instant display on revisit; you can delete entries anytime in Settings → Cache Manager |

## Your control

- Translation runs **manually by default** — nothing is sent anywhere until you click Translate/Summarize (unless you enable auto-translate).
- All cached data can be deleted at any time from the extension's built-in cache manager.
- Removing the extension deletes all locally stored data.

## Third-party services

When you configure the Gemini engine, caption text/video URLs are processed by Google under
[Google's terms and privacy policy](https://policies.google.com/privacy). When you use the
Claude CLI engine, data is processed by your own local server and Anthropic under
[Anthropic's privacy policy](https://www.anthropic.com/legal/privacy), using your own account.

## Contact

Questions: open an issue at https://github.com/garamssi/neotube_translate/issues
