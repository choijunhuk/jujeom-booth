# 주점 부스 — QR 주문 + 보상 게임

동아리 주점 부스용 웹 앱. 테이블의 QR을 찍으면 설치나 로그인 없이 주문하고, 기다리는 동안 게임을 해서 쿠폰을 받는다. 스태프는 휴대폰이나 노트북으로 주문을 처리한다.

## 기능

**손님** (`/t/<테이블 토큰>`)
- 메뉴, 장바구니, 주문, 계좌이체 안내, 실시간 주문 현황, 직원 호출
- 게임 2종: 생맥 따르기, 건배 타이밍. 기준 점수를 넘기면 쿠폰 발급
- 입구 QR로 대기 등록 (`/wait`)

**스태프** (`/staff`, PIN 로그인)
- 주문 보드, 테이블 현황·계산서·자리 이동·정리
- 쿠폰 사용 처리, 품절·주문 마감, 대기 명단, 매출 CSV
- 주방 화면 (`/kitchen`), 전광판 랭킹 (`/board`), 테이블 QR 인쇄 (`/staff/qr`)

## 구성

- Node.js 프로세스 1개, npm 의존성 0개 (`node:http`, `node:sqlite`)
- SQLite 파일 1개, 실시간 갱신은 SSE
- 화면은 빌드 과정 없는 HTML/CSS/JS, 게임은 Canvas
- 기준 경로를 환경 변수로 바꿀 수 있어 다른 사이트의 하위 경로(`/booth`)에 붙일 수 있다

## 실행

Node 26 (개발과 Docker 이미지가 쓰는 버전).

```bash
NODE_ENV=development node server.js
```

- 스태프: `http://localhost:8787/staff` (개발 모드 PIN `0000`)
- 손님 화면 주소는 스태프의 QR 인쇄 화면에서 확인한다

테스트와 머지 게이트:

```bash
node --test
tools/gate.sh
```

## 설정

| 파일 | 내용 |
|---|---|
| `menu.json` | 메뉴와 가격 |
| `rewards.json` | 게임별 기준 점수, 보상 종류, 준비 수량 |
| `tables.json` | 테이블 수 |
| `.env` | 스태프 PIN, 계좌 정보 (`.env.example` 참고, git에 올리지 않는다) |

JSON 파일을 바꾸면 서버를 다시 시작해야 한다.

## 배포

```bash
cp .env.example .env   # STAFF_PIN, PAY_* 채우기
docker compose -p booth up -d --build
```

컨테이너는 `127.0.0.1:4200`에만 열린다. 앞단 nginx에는 `deploy/`의 두 파일을 쓴다. 절차는 [PLAN.md](PLAN.md) 10장, API는 [API.md](API.md)에 있다.

## 문서

- [PLAN.md](PLAN.md): 기획, 화면 구성, 보상 설계, 배포 절차
- [API.md](API.md): 엔드포인트와 실시간 이벤트
