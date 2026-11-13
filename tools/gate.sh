#!/usr/bin/env bash
# 머지 게이트. 하나라도 실패하면 0 이 아닌 값으로 끝난다.
# 실행: tools/gate.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "[1/4] 문법 검사"
for f in server.js db.js test.js public/*.js public/games/*.js public/vendor/*.js; do
  node --check "$f"
done

echo "[2/4] 테스트 (백엔드 + 게임 점수)"
node --test

echo "[3/4] 외부 요청 금지 (CSP 는 self 만 허용)"
if grep -rnE "(src|href)=[\"']https?://|fetch\([\"']https?://|@import|url\([\"']?https?://" public/ --include='*.html' --include='*.js' --include='*.css'; then
  echo "public/ 에 외부 주소가 있다" >&2; exit 1
fi

echo "[4/4] 비밀 값 금지"
if git ls-files --error-unmatch .env >/dev/null 2>&1; then
  echo ".env 가 git 에 올라가 있다" >&2; exit 1
fi
if git grep -nIE "(STAFF_PIN|PAY_ACCOUNT)\s*[=:]\s*[\"']?[0-9][0-9-]{3,}" -- . ':!.env.example' ':!test.js' ':!tools/gate.sh' ':!API.md' ':!PLAN.md'; then
  echo "PIN 이나 계좌번호가 코드에 적혀 있다" >&2; exit 1
fi

echo "게이트 통과"
