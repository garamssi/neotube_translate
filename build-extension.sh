#!/usr/bin/env bash
#
# 크롬 웹스토어 업로드용 확장 프로그램 zip 을 만든다.
#
#   사용법:  ./build-extension.sh
#   결과:    dist/youtube-ai-subtitle-translator-<manifest.version>.zip  (manifest 가 zip 루트)
#
# 하는 일:
#   1) 런타임 파일만 스테이징 (INCLUDE 방식: 아래 목록만 담음 — 번들러 없음, 소스가 곧 런타임)
#   2) manifest / background.js importScripts / popup.html 이 참조하는 파일이 모두 포함됐는지 검증
#   3) 버전 번호로 zip 생성
#
# 포함: manifest.json / constants.js / inject.js / background.js / bg/ / content/ /
#       panel.css · overlay.css / popup.html · popup.js / icons/
# 제외: server/(로컬 번역 서버 — 확장 아님), node_modules, README·PRIVACY,
#       package*.json, jsconfig.json, *.zip, .git 등
#
# 요구: node, zip

set -euo pipefail

# 스크립트 위치 = 저장소 루트로 이동 (어디서 실행하든 동일하게 동작)
cd "$(dirname "$0")"
ROOT="$(pwd)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

VERSION="$(node -e "process.stdout.write(require('./manifest.json').version)")"
OUT="$ROOT/dist/youtube-ai-subtitle-translator-$VERSION.zip"
echo "▶ 버전: $VERSION"

echo "▶ 런타임 파일 스테이징…"
cp manifest.json constants.js inject.js background.js panel.css overlay.css \
   popup.html popup.js "$STAGE"/
cp -R bg "$STAGE"/bg
cp -R content "$STAGE"/content
cp -R icons "$STAGE"/icons

echo "▶ 참조 파일 검증…"
node -e '
const fs = require("fs");
const stage = process.argv[1];
const refs = new Set();

// 1) manifest 참조: content_scripts js/css · service worker · popup · icons
const m = require("./manifest.json");
(m.content_scripts || []).forEach(c => {
  (c.js || []).forEach(j => refs.add(j));
  (c.css || []).forEach(x => refs.add(x));
});
if (m.background && m.background.service_worker) refs.add(m.background.service_worker);
if (m.action && m.action.default_popup) refs.add(m.action.default_popup);
Object.values((m.action && m.action.default_icon) || {}).forEach(i => refs.add(i));
Object.values(m.icons || {}).forEach(i => refs.add(i));

// 2) 서비스 워커 importScripts 참조 — bg/ 모듈은 manifest 에 나오지 않는다
const sw = fs.readFileSync("background.js", "utf-8");
for (const call of sw.matchAll(/importScripts\(([^)]*)\)/g)) {
  for (const f of call[1].matchAll(/["\x27]([^"\x27]+)["\x27]/g)) refs.add(f[1]);
}

// 3) popup.html 의 <script src> 참조 (constants.js 공유 로드)
const popup = fs.readFileSync("popup.html", "utf-8");
for (const s of popup.matchAll(/<script[^>]+src="([^"]+)"/g)) refs.add(s[1]);

let ok = true;
[...refs].forEach(r => {
  if (!fs.existsSync(stage + "/" + r)) { ok = false; console.error("  ❌ 누락:", r); }
});
if (!ok) { console.error("→ 참조 파일이 패키지에 없음"); process.exit(1); }
console.log(`  ✅ 참조 파일 ${refs.size}개 전부 포함`);
' "$STAGE"

echo "▶ zip 생성…"
mkdir -p "$ROOT/dist"
rm -f "$OUT"
find "$STAGE" -name ".DS_Store" -delete
( cd "$STAGE" && zip -r -X -q "$OUT" . -x "*.DS_Store" )

echo "✅ 완료: $OUT ($(du -h "$OUT" | cut -f1), $(unzip -l "$OUT" | tail -1 | awk '{print $2}') files)"
