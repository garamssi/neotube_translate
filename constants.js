const YTX = {
  MSG_SOURCE: 'yt-sub-ext',

  MSG: {
    CAPTION_RAW: 'CAPTION_RAW',
    CAPTION_TRACKS: 'CAPTION_TRACKS',
    SEGMENTS: 'SEGMENTS',
    CAPTION_ERROR: 'CAPTION_ERROR',
    TRANSLATE_START: 'TRANSLATE_START',
    TRANS_STATUS: 'TRANS_STATUS',
    TRANS_PROGRESS: 'TRANS_PROGRESS',
    TRANS_CHUNK_ERROR: 'TRANS_CHUNK_ERROR',
    TRANS_COMPLETE: 'TRANS_COMPLETE',
    SUMMARIZE_START: 'SUMMARIZE_START',
    SUMMARY_PROGRESS: 'SUMMARY_PROGRESS',
    SUMMARY_COMPLETE: 'SUMMARY_COMPLETE',
    SUMMARY_ERROR: 'SUMMARY_ERROR',
    DEBUG_GET: 'DEBUG_GET',
    DEBUG_CLEAR: 'DEBUG_CLEAR',
    TAB_RESET: 'TAB_RESET'
  },

  SEL: {
    SECONDARY: '#secondary',
    SECONDARY_INNER: '#secondary-inner',
    PLAYER: '#movie_player',
    PLAYER_FALLBACK: '.html5-video-player',
    VIDEO: 'video.html5-main-video',
    NATIVE_CAPTION: '.ytp-caption-window-container',
    CC_BUTTON: '.ytp-subtitles-button',
    CONTROLS_AUTOHIDE_CLASS: 'ytp-autohide',
    FULLSCREEN_CLASS: 'ytp-fullscreen',
    WATCH_FLEXY: 'ytd-watch-flexy',
    THEATER_ATTR: 'theater',
    FULLSCREEN_ATTR: 'fullscreen'
  },

  TIMEDTEXT_URL_PATTERN: '*://*.youtube.com/api/timedtext*',
  TIMEDTEXT_KEYWORD: 'timedtext',
  FALLBACK_REFETCH_DELAY_MS: 4000,
  CC_AUTO_ENABLE_DELAY_MS: 3000,

  CHUNK_LOCALHOST: { SEGMENTS: 60, CHARS: 8000, FIRST: 20, PARALLEL: 3 },
  CHUNK_GEMINI: {
    OUTPUT_TOKEN_BUDGET: 8000,
    EST_TOKENS_PER_CHAR: 0.6,
    EST_TOKENS_PER_SEG: 3,
    PARALLEL: 2
  },
  CHUNK_OPENAI: {
    OUTPUT_TOKEN_BUDGET: 8000,
    EST_TOKENS_PER_CHAR: 0.6,
    EST_TOKENS_PER_SEG: 3,
    PARALLEL: 2
  },
  RETRY_BACKOFF_MS: [1000, 4000],
  LOCALHOST_TIMEOUT_MS: 180000,

  GEMINI: {
    API_BASE: 'https://generativelanguage.googleapis.com/v1beta/models',
    MODELS: [
      { value: 'gemini-3.8-flash', label: 'gemini-3.8-flash (권장, 무료 티어)', thinking: 'low' },
      { value: 'gemini-3.5-flash-lite', label: 'gemini-3.5-flash-lite (최저가, 무료 티어)', thinking: 'minimal' },
      { value: 'gemini-4-hydrogen', label: 'gemini-4-hydrogen (균형, 무료 티어)', thinking: 'low' },
      { value: 'gemini-4-argon', label: 'gemini-4-argon (고품질, 유료 전용)', thinking: 'low' },
      { value: 'gemini-4-carbon', label: 'gemini-4-carbon (최고 품질, 유료 전용)', thinking: 'low' }
    ],
    DEFAULT_MODEL: 'gemini-3.8-flash',
    PACING: { free: 6500, paid: 400 }
  },

  OPENAI: {
    API_URL: 'https://api.openai.com/v1/chat/completions',
    MODELS: [
      { value: 'gpt-6-luna', label: 'gpt-6-luna (권장, 저가, 고속)', effort: 'none' },
      { value: 'gpt-6.1-terra', label: 'gpt-6.1-terra (균형)', effort: 'none' },
      { value: 'gpt-6.1-sol', label: 'gpt-6.1-sol (품질 우선)', effort: 'low' },
      { value: 'gpt-6-astra', label: 'gpt-6-astra (최고 품질)', effort: 'low' }
    ],
    DEFAULT_MODEL: 'gpt-6-luna',
    MAX_COMPLETION_TOKENS: 16384
  },

  DEFAULT_SETTINGS: {
    enabled: true,
    autoTranslate: false,
    route: 'localhost',
    geminiApiKey: '',
    geminiModel: 'gemini-3.8-flash',
    geminiTier: 'free',
    geminiSummarySource: 'video',
    openaiApiKey: '',
    openaiModel: 'gpt-6-luna',
    serverAddress: 'localhost:8787',
    targetLang: 'ko',
    summaryLevel: 'standard',
    summaryClaudeModel: 'auto',
    defMode: 'rows',
    defFollow: true,
    panelCollapsed: false,
    overlayOn: true,
    overlayMode: 'replace',
    overlayFontSize: 'md'
  },

  STORAGE: {
    SETTINGS: 'settings',
    CACHE_PREFIX: 'cache',
    SUM_PREFIX: 'sum'
  },

  SUMMARY_LEVELS: [
    { value: 'brief', label: '짧게', model: 'haiku', effort: 'low' },
    { value: 'standard', label: '표준', model: 'sonnet', effort: 'low' },
    { value: 'detailed', label: '상세', model: 'sonnet', effort: 'medium' }
  ],

  CLAUDE_SUMMARY_MODELS: [
    { value: 'auto', label: '자동 (수준별 권장)' },
    { value: 'haiku', label: 'Haiku 5.5 (빠름)' },
    { value: 'sonnet', label: 'Sonnet 5.5 (정밀)' },
    { value: 'opus', label: 'Opus 5.5 (고품질)' },
    { value: 'fable', label: 'Fable 5.2 (최고 품질, 느림)' }
  ],

  TARGET_LANGS: [
    ['ko', '한국어'], ['en', 'English'], ['ja', '日本語'],
    ['zh-CN', '中文(简体)'], ['zh-TW', '中文(繁體)'],
    ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch'],
    ['pt', 'Português'], ['ru', 'Русский'], ['vi', 'Tiếng Việt'],
    ['th', 'ไทย'], ['id', 'Bahasa Indonesia'], ['hi', 'हिन्दी'],
    ['ar', 'العربية'], ['it', 'Italiano'], ['tr', 'Türkçe']
  ],

  LOG: '[yt-sub-ext]',

  normalizeSettings(stored) {
    const s = { ...YTX.DEFAULT_SETTINGS, ...(stored || {}) };
    if ((!stored || !stored.serverAddress) && stored && stored.port) {
      s.serverAddress = `localhost:${stored.port}`;
    }
    delete s.port;
    const listed = (models, value) => models.some((m) => m.value === value);
    if (!listed(YTX.GEMINI.MODELS, s.geminiModel)) s.geminiModel = YTX.GEMINI.DEFAULT_MODEL;
    if (!listed(YTX.OPENAI.MODELS, s.openaiModel)) s.openaiModel = YTX.OPENAI.DEFAULT_MODEL;
    if (!listed(YTX.CLAUDE_SUMMARY_MODELS, s.summaryClaudeModel)) s.summaryClaudeModel = 'auto';
    return s;
  },

  engineModelTag(s) {
    if (s.route === 'gemini') return s.geminiModel || YTX.GEMINI.DEFAULT_MODEL;
    if (s.route === 'openai') return s.openaiModel || YTX.OPENAI.DEFAULT_MODEL;
    return 'cli';
  },

  cacheKey(videoId, targetLang, route, modelTag) {
    return `${YTX.STORAGE.CACHE_PREFIX}|${videoId}|${targetLang}|${route}|${modelTag || ''}`;
  },

  cacheKeyPrefix(videoId, targetLang) {
    return `${YTX.STORAGE.CACHE_PREFIX}|${videoId}|${targetLang}|`;
  },

  sumKey(videoId, targetLang, route, model, level) {
    return `${YTX.STORAGE.SUM_PREFIX}|${videoId}|${targetLang}|${route}|${model}|${level}`;
  },

  buildServerBase(address) {
    let a = String(address || YTX.DEFAULT_SETTINGS.serverAddress).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(a)) a = `http://${a}`;
    return a;
  }
};

if (typeof self !== 'undefined') self.YTX = YTX;
