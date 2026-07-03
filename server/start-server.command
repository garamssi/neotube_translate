#!/bin/bash
# 유튜브 자막 번역 서버 실행 스크립트 (Finder 더블클릭 가능)
# start-proxy.command(유데미)와 동일한 구조: nvm 로드 → 포트 정리 → 서버 실행

# 터미널 타이틀
echo -ne "\033]0;YouTube 자막 번역 서버 (Claude)\007"

# 스크립트 위치(server/) 기준으로 이동
cd "$(dirname "$0")" || exit 1

# nvm 로드 — Finder 실행 시 PATH에 node가 없는 문제 방지.
# 유데미 스크립트와 동일하게 nvm default 버전이 활성화되므로,
# 평소 로그인해서 쓰는 claude와 같은 개체가 잡힌다.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

PORT="${PORT:-8787}"

# 기존 서버 종료
if lsof -ti:"$PORT" > /dev/null 2>&1; then
  echo "기존 서버(:$PORT) 종료 중..."
  kill $(lsof -ti:"$PORT") 2>/dev/null
  sleep 1
fi

echo "========================================"
echo "  YouTube 자막 번역 서버 (claude -p)"
echo "  포트: $PORT · 종료: Ctrl+C"
echo "========================================"
echo ""

PORT="$PORT" node translate-server.js

echo ""
echo "========================================"
echo "  서버가 종료되었습니다."
echo "  아무 키나 누르면 터미널을 닫습니다."
echo "========================================"
read -n 1 -s
