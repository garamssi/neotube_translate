# Chrome 웹스토어 업로드 가이드

업로드 파일: `dist/youtube-ai-subtitle-translator-v0.1.1.zip`
(확장 실행에 필요한 23개 파일만 포함 — server/, 문서, 개발 설정, git 관련 전부 제외)

> 이 문서의 설명은 한글이지만, **스토어 입력란에 붙여넣을 문안은 전부 영어**로 아래에 준비되어 있습니다.
> `[EN]` 블록을 그대로 복사해 쓰세요.

---

## 0. 사전 준비

1. **개발자 계정 등록**: https://chrome.google.com/webstore/devconsole 접속 → Google 계정 로그인 → 최초 1회 등록비 **$5** 결제
2. **스크린샷 준비 (필수)**: 1280×800(권장) 또는 640×400 PNG/JPG, 최소 1장·최대 5장
   - 추천 장면: ① 패널+번역 목록 ② 영상 오버레이 자막 ③ 요약 탭 ④ 설정 화면
3. (권장) **개인정보처리방침 URL**: 이 저장소의 `PRIVACY.md`를 GitHub에 푸시하면
   `https://github.com/garamssi/neotube_translate/blob/main/PRIVACY.md` 를 그대로 쓸 수 있습니다.
   API 키(인증 정보)를 다루므로 심사에서 요구될 가능성이 높습니다.

## 1. 업로드

1. 개발자 대시보드 → **+ New item** → `dist/youtube-ai-subtitle-translator-v0.1.1.zip` 업로드
2. 업로드되면 자동으로 manifest를 읽어 이름/버전이 표시됩니다
   (확장 이름은 대시보드가 아니라 **manifest의 name**에서 옵니다 — 이미 영어로 설정됨:
   `YouTube AI Subtitle Translator`)

## 2. Store listing 탭

| 입력란 | 넣을 값 |
|---|---|
| Title | (manifest에서 자동) YouTube AI Subtitle Translator |
| Summary | 아래 [EN] Summary |
| Description | 아래 [EN] Description |
| Category | Productivity → Tools |
| Language | English (미국) — UI가 한국어임은 Description에 명시되어 있음 |
| Store icon | `icons/icon128.png` 업로드 |
| Screenshots | 준비한 스크린샷 |

**[EN] Summary** (132자 제한):

```
AI-powered YouTube caption translation: transcript panel, on-video subtitle overlay, and AI video summaries. Claude CLI or Gemini.
```

**[EN] Description**:

```
Translate YouTube captions with AI, right on the watch page.

FEATURES
• Transcript panel — timestamped list or paragraph view of translated captions, synced with playback. Click any line to seek.
• On-video subtitle overlay — translated subtitles rendered over the video (replace or bilingual mode, adjustable font size). Works in theater and fullscreen mode.
• AI video summaries — TL;DR plus a clickable timeline of sections, with three detail levels (brief / standard / detailed).
• Manual or automatic translation — by default, nothing is translated until you click the Translate button, so you stay in control of API usage.
• Smart caching — translations and summaries are cached locally per video, so revisits are instant. Built-in cache manager with search and filters.

TRANSLATION ENGINES (bring your own)
1) Claude CLI — runs through a small local server included in the project (requires the Claude Code CLI and a Claude subscription). Nothing is sent anywhere except to Anthropic via your own CLI.
2) Gemini API — uses your own Gemini API key. For summaries, only the video URL is sent so Gemini can analyze the video directly.

PRIVACY
• No analytics, no tracking, no third-party servers.
• Your API key is stored only in Chrome's local extension storage and is sent only to Google's Gemini API.
• Caption text is sent only to the translation engine you configure.

NOTES
• The extension UI is currently in Korean. English UI is planned.
• Requires captions (CC) to be available on the video. The extension can fetch caption tracks automatically without turning CC on.
• Setup guide for the local Claude server: see the GitHub repository.

Source code: https://github.com/garamssi/neotube_translate
```

## 3. 개인 정보 보호 관행 탭 (심사 통과의 핵심)

대시보드 화면에 나오는 **입력란 순서 그대로** 매핑했습니다. 각 [EN] 블록을 해당 칸에 붙여넣으세요.

### ① 전용 목적 — "전용 목적 설명*"

```
This extension has a single purpose: translating YouTube video captions with AI. It displays the translated captions as a transcript panel and an on-video subtitle overlay on YouTube watch pages, and can generate an AI summary of the same captions. All features are different presentations of the one purpose above.
```

### ② 권한 요청 이유

**"storage 사용 근거*"**:

```
Stores user preferences (translation engine, target language, display options) and locally caches translation/summary results per video, so revisiting a video does not re-consume the user's own API quota. No data leaves the browser through this permission.
```

**"webRequest 사용 근거*"**:

```
Used in read-only, non-blocking observation mode only: the extension observes YouTube's own caption (timedtext) requests as a fallback to reliably identify the caption track the user is watching. No requests are modified, redirected, or blocked (webRequestBlocking is not requested).
```

**"호스트 권한 사용 근거*"** (두 호스트를 한 칸에 함께 설명):

```
Two host patterns are requested. (1) *://*.youtube.com/* — required to inject the transcript panel and subtitle overlay into YouTube watch pages and to fetch the caption track (timedtext) of the video the user chooses to translate. The extension only runs on YouTube. (2) http://localhost/* — lets the user connect the extension to their own local translation helper server (Claude CLI) running on their own machine. No developer-operated or third-party server is contacted.
```

**"원격 코드 사용 중이신가요?"** → **"아니요, 원격 코드 권한을 사용하고 있지 않습니다" 선택**

- 모든 코드가 패키지에 포함되어 있고 CDN 로드·eval·외부 스크립트가 없습니다.
- "예"를 선택하면 불필요한 정밀 심사를 받으니 주의. ("예" 선택 시에만 근거란이 나타남 — 우리는 해당 없음)

### ③ 사용자 데이터 사용 — 체크리스트

"현재 또는 향후 수집할 계획인 사용자 데이터" 중 **딱 2개만 체크**:

| 항목 | 체크 | 이유 |
|---|---|---|
| 개인 식별 정보 | ☐ | 수집 안 함 |
| 건강 정보 | ☐ | — |
| 금융 및 결제 정보 | ☐ | — |
| **인증 정보** | ☑ | 사용자가 입력하는 Gemini API 키를 로컬(chrome.storage)에 저장 |
| 개인적인 커뮤니케이션 | ☐ | — |
| 위치 | ☐ | — |
| 웹 기록 | ☐ | — |
| 사용자 활동 | ☐ | — |
| **웹사이트 콘텐츠** | ☑ | 영상 자막 텍스트가 사용자가 설정한 번역 엔진(Gemini 또는 본인 로컬 서버)으로 전송됨 |

**"다음과 같이 밝힌 내용이 사실임을 확인합니다" 3개 서약 모두 체크**:

- ☑ 승인된 사용 사례를 제외하고 사용자 데이터를 제3자에 판매 또는 전송하지 않음
- ☑ 항목의 전용 목적과 관련 없는 목적으로 사용자 데이터를 사용하거나 전송하지 않습니다
- ☑ 신용도 판단 또는 대출을 위해 사용자 데이터를 사용하거나 전송하지 않습니다

### ④ 개인정보처리방침 — "개인정보처리방침 URL*"

```
https://github.com/garamssi/neotube_translate/blob/main/PRIVACY.md
```

(저장소의 `PRIVACY.md`가 푸시되어 있어야 접속 가능 — 미푸시 상태면 먼저 `git push`)

### 참고: 노란 경고 배너

"호스트 권한으로 인해 자세한 검토가 필요합니다 / 게시가 지연될 수 있습니다"는 **정상 안내**입니다.
youtube.com 호스트 권한이 있는 모든 확장에 뜨며, 위 사유들이 충실하면 통과에 문제 없습니다.
심사 기간이 1~2주까지 길어질 수 있다는 의미일 뿐입니다.

## 4. Distribution 탭

- Visibility: **Public** (누구나 검색) / 지인만 쓸 거면 **Unlisted** (링크로만 접근)
- 국가: All regions

## 5. 제출 & 심사

1. 우측 상단 **Submit for review**
2. 심사 기간: 보통 1~3일, 권한이 많은 확장은 1~2주까지 가능
3. 반려가 잦은 포인트와 이 확장의 대비 상태:
   - 원격 코드 실행 → 없음 (전부 패키지 내)
   - 권한 과다 → webRequest/host 권한 사유를 위 문안으로 소명
   - 단일 목적 위반 → 번역·오버레이·요약 모두 "자막 AI 번역" 단일 목적의 표현 방식임을 Single purpose 문안이 커버

## 6. 업데이트 배포

1. `manifest.json`의 `version` 올리기 (예: 0.1.1 → 0.1.2)
2. zip 재생성 (아래 명령) → 대시보드 → 해당 항목 → **Package → Upload new package**

```bash
# 프로젝트 루트에서 (macOS/Linux)
mkdir -p dist && zip -r dist/ext-$(date +%Y%m%d).zip \
  manifest.json constants.js inject.js background.js \
  panel.css overlay.css popup.html popup.js bg content icons \
  -x "*.DS_Store"
```

---

## 패키지 구성 (23파일, ~188KB)

포함: `manifest.json`, `constants.js`, `inject.js`, `background.js`, `bg/`(4), `content/`(4),
`panel.css`, `overlay.css`, `popup.html`, `popup.js`, `icons/`(4)

제외 및 사유:

| 제외 | 사유 |
|---|---|
| `server/` | 로컬 번역 서버 — 확장 코드 아님 (사용자는 GitHub에서 받음) |
| `README.md`, `docs/` | 문서 — 실행 무관, 심사 시 불필요한 검토 표면만 늘림 |
| `package.json`, `package-lock.json`, `jsconfig.json`, `node_modules/` | 에디터용 개발 설정 |
| `.git`, `.gitignore`, `.idea` | 버전 관리/IDE |
