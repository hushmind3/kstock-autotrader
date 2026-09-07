# K-Stock Autotrader

키움증권 REST API/WebSocket과 한국투자증권 KIS Open API를 동시에 연결하는 자동매매 프로그램입니다. 로컬 PC와 Linux 클라우드가 같은 코드와 데이터 모델을 사용합니다. 웹 화면은 운용과 설정만 담당하고, 주문·감시·복구는 별도 `trading-engine` 프로세스가 담당합니다. 브라우저를 닫아도 엔진은 계속 실행됩니다.

> 이 저장소는 실제 증권사 API를 호출하도록 구현되어 있습니다. 자격증명이 없을 때 가상 시세나 가짜 주문으로 대체하지 않습니다. 기본 상태는 `HALTED`, 기본 계좌 환경은 `paper`입니다.

## 첫 실행

현재 맥에서는 [KStock Trader.app](./outputs/KStock%20Trader.app)을 더블클릭하면 됩니다. 콘솔 명령은 필요 없습니다. 앱이 `trading-engine`과 웹 화면을 백그라운드에서 함께 시작하고, 두 서비스의 설치 식별자·빌드·관리 토큰을 확인한 뒤 브라우저를 자동으로 엽니다. 실행 중 프로세스가 종료되면 숨은 런처가 제한된 재시도 간격으로 다시 시작합니다.

- macOS 즉시 실행: `outputs/KStock Trader.app`
- Windows: `outputs/KStock Trader (Windows).vbs`
- API Key, Secret, 계좌번호, KIS 상품코드·HTS ID는 웹의 **설정 → 저장하고 연결 시작**에서 입력합니다.
- 로컬 비밀값은 macOS Keychain/Windows Credential Manager에 저장되고, 브라우저 코드와 SQLite에는 저장되지 않습니다.
- `KSTOCK_MASTER_KEY`가 설정된 서버에서는 같은 UI 입력값이 AES-256-GCM 암호화 파일로 저장됩니다.
- 자격정보를 저장해도 자동매매·신규매수·전체 안전정지는 자동으로 해제되지 않습니다.

- 운영 화면: `http://127.0.0.1:3100`
- 엔진 API: `http://127.0.0.1:3210` (loopback + 로컬 관리 토큰 보호)
- `.env`는 개발용 fallback이며, 비밀값에 `NEXT_PUBLIC_` 접두사를 붙이면 안 됩니다.

소스 개발·서버 운용 시에만 아래 명령을 사용합니다. 요구 런타임은 Node.js 22 이상입니다.

```bash
npm install
npm run build
npm start
```

개발 모드는 `npm run dev`, 엔진만 상시 실행하려면 `npm run start -w @kstock/trading-engine`을 사용합니다. 노트북 절전 중에는 어떤 로컬 프로그램도 시세를 감시하거나 주문할 수 없으므로 장중에는 절전을 끄거나 상시 가동 호스트를 사용해야 합니다.

## 동일 코드로 클라우드 실행

Linux 서버에는 `.env.example`을 참고해 `.env`를 만들고 32자 이상의 `KSTOCK_ADMIN_TOKEN`, `KSTOCK_MASTER_KEY`, 16자 이상의 `KSTOCK_WEB_PASSWORD`, 사용할 증권사 자격증명을 지정합니다. 이후 코드를 수정하지 않고 실행합니다.

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f trading-engine
```

- `restart: unless-stopped`로 프로세스가 자동 재시작됩니다.
- SQLite, 전략설정, 주문·체결·보유·손익·정지상태, 암호화 토큰 캐시는 `kstock-data` 영속 볼륨에 남습니다.
- 시작 시 DB lease를 획득하고 미확인 주문, 당일 체결, 미체결, 실제 잔고를 다시 대사합니다. 대사가 끝나기 전에는 주문이 차단됩니다.
- 컨테이너에서는 OS 보안 저장소 대신 환경변수와 AES-256-GCM 암호화 토큰 캐시를 사용합니다.
- 엔진 포트는 외부에 공개하지 않고 웹의 서버측 프록시만 접근합니다. 외부 HTTPS/TLS는 배포 서버의 reverse proxy에서 종료하세요.
- 클라우드 웹은 기본적으로 HTTP Basic 인증을 요구합니다. 증권사 키와 엔진 관리 토큰은 브라우저 번들로 전달되지 않습니다.

## 프로젝트 구조

```text
web/                              Next.js 운영 화면과 서버 전용 로컬 프록시
trading-engine/                   자동매매, 위험관리, 복구, 로컬 API
broker-adapters/kiwoom/           키움 REST/WebSocket 어댑터
broker-adapters/koreainvestment/  KIS REST/WebSocket 어댑터
strategies/                       교체 가능한 결정적 전략 모듈
database/                         SQLite 원장과 원자적 주문 outbox
shared/                           공통 타입, 설정 스키마, 브로커 계약
docs/                             공식 API 검증 및 운영 설계
```

## 코스피 전체 감시의 정확한 의미

개인용 공식 API의 WebSocket 제한 때문에 전 코스피 종목을 한 계정에서 동시에 tick-by-tick 구독할 수 없습니다. 키움은 세션당 200종목, KIS는 안전 기본값 40종목입니다. 엔진은 다음 방식으로 전체 종목을 검사합니다.

1. 공식 종목목록/마스터를 매일 동기화합니다.
2. 전체 종목의 확정 일봉을 SQLite에 증분 저장하고 21일·60일 조건을 계산합니다.
3. 키움 `ka10095`, KIS 30종목 일괄현재가 조회로 전 종목을 순환 갱신합니다.
4. 보유·미체결·매도감시·상위 매수후보 순으로 WebSocket 슬롯을 배정합니다.
5. 화면에서 전체 순환 감시 수와 실시간 구독 수를 따로 표시합니다.

전 종목의 모든 틱이 필요하면 증권사 유량 증설 또는 별도 라이선스 시세 피드가 필요합니다.

## 안전 원칙

- 전략은 순수 함수이며 브로커, DB, LLM에 접근하지 않습니다.
- 주문은 위험검사, 예산예약, 멱등성 키, outbox 저장 후에만 전송합니다.
- 주문 타임아웃은 자동 재전송하지 않고 `UNKNOWN`으로 격리한 뒤 브로커 원장과 대사합니다.
- 재시작 시 전송 전 `QUEUED` 주문은 현재 시세·잔고·장 상태를 우회하지 않도록 만료하고, 이미 전송을 시작한 주문만 `UNKNOWN`으로 격리해 원장 대사합니다.
- REST 누적 체결과 WebSocket 개별 체결이 겹쳐도 SQLite 원장에는 양의 차이만 기록합니다.
- DB 장애, 시세 노후, WebSocket 단절, 계좌 불일치는 fail-closed 처리합니다.
- 실전과 모의는 URL, 키, TR_ID, DB scope가 완전히 분리됩니다.
- 전체 정지와 증권사별 정지는 SQLite에 영속되어 재시작으로 해제되지 않습니다.
- 민감한 응답 원문은 저장 전 계좌·토큰·키를 제거합니다.

## 검증

```bash
npm run typecheck
npm test
npm run build
```

자격증명 없는 로컬 테스트는 전략, DB 상태기계, 누적/중복 체결, 재시작 복구, 엔진 API, 웹 프록시, 멱등성, 위험검사, 빌드를 검증합니다. 토큰 발급, 장중 WebSocket, 신규·정정·취소, 부분체결, 재시작 대사는 양사 모의계좌로 별도 장중 검증해야 하며, 그 전에는 실전 자동매매를 켜면 안 됩니다.
