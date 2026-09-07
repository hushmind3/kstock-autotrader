# 한국 주식 자동매매 구현·검증 보고서

기준일: 2026-09-02

## UI 실행·자격정보 입력 보강

- macOS `KStock Trader.app`과 Windows 숨김 런처를 추가했다. 더블클릭하면 웹과 엔진이 함께 시작되고 준비 완료 후 운영 화면이 열린다.
- 런처는 `.env`를 읽고, 소스 지문과 운영 빌드가 다르면 자동으로 다시 빌드하며, 설치 식별자·서비스 종류·빌드 지문·엔진 관리 토큰까지 확인한다.
- 동시 실행 잠금과 백그라운드 감시/재시작을 추가했다. 브라우저를 닫아도 엔진은 계속 동작한다.
- 설정 화면에서 키움/KIS 키·시크릿·계좌정보를 직접 입력하고 `저장하고 연결 시작`을 누를 수 있다. 콘솔 setup 절차는 제거했다.
- 환경변수는 UI에서 덮어쓰거나 삭제할 수 없고, 로컬은 OS 보안 저장소, 서버는 `KSTOCK_MASTER_KEY` 기반 AES-256-GCM 암호화 파일을 사용한다.
- 저장 후 연결은 인증·계좌 대사를 시도하지만 자동매매와 신규매수는 강제로 정지된 상태를 유지하고 전체 안전정지를 해제하지 않는다.

## 구현 결과

하나의 TypeScript 모노레포에서 Next.js 운영 화면과 독립 Fastify `trading-engine`을 함께 실행하도록 구현했다. 루트에서 `npm run dev` 또는 빌드 후 `npm start`를 실행하면 두 프로세스가 동시에 시작되며, 브라우저를 닫아도 엔진 프로세스는 계속 동작한다.

실제 주문 경로는 다음과 같다.

1. OS 보안 저장소 또는 서버 환경변수에서 증권사 자격증명 로드
2. 키움/KIS 토큰 발급·캐시·만료 갱신
3. 설정된 계좌가 API 키에 속하는지 확인하고 잔고·예수금·미체결 조회
4. WebSocket 시세와 계좌 주문·체결 통보 연결 및 자동 재연결
5. 공식 코스피 종목목록/마스터 동기화와 상장·상폐 diff 반영
6. 전략이 요구하는 확정 일봉을 전 종목에 적재한 뒤 일괄현재가 순환 스캔
7. 독립 전략 모듈이 `BUY`/`SELL`/`HOLD`/`NOT_READY` 결정
8. 영속 kill switch, 장 상태, 시세 신선도, 실제 주문가능현금, 계좌·종목·일일 한도, 최대 보유 수, 중복 주문을 재검사
9. 주문 intent·위험금액 예약·outbox를 SQLite 트랜잭션에 먼저 저장
10. 키움/KIS 실제 신규·정정·취소 API 호출
11. REST 대사와 WebSocket 통보로 접수·부분체결·체결·취소를 원장에 반영
12. 보유 감시 중 매도 조건 발생 시 같은 안전 경로로 매도 주문

가상 시세, 가짜 계좌, 가짜 주문 성공 함수는 넣지 않았다. 자격증명이 없거나 어느 안전 게이트라도 확인되지 않으면 주문하지 않고 `HALTED`/`DEGRADED` 상태를 표시한다.

## 핵심 안전·복구 동작

- 키움과 KIS를 동시에 켜거나 각각 독립적으로 켤 수 있고, 전략·투자한도·실전/모의 환경·원장이 계좌별로 분리된다.
- 기본값은 전체 안전정지, 자동매매 OFF, 신규매수 정지, 모의투자다.
- 증권사 장 운영상태/공식 개장일이 당일 확인되지 않으면 신규 주문을 차단한다.
- 주문 응답 타임아웃과 네트워크 단절은 성공으로 간주하거나 재전송하지 않고 `UNKNOWN`으로 격리한다.
- 재시작 시 전송 전 `QUEUED` 주문은 만료하고, 이미 전송을 시작한 주문만 브로커 원장과 대사한다.
- 키움 `kt00009`와 KIS 당일 주문이력으로 미체결 목록에서 사라진 주문을 확인한다. 키움 취소는 원주문번호와 취소 확인수량/확인 상태가 명시된 경우에만 원주문을 종료한다.
- REST 누적 체결과 WebSocket 개별 체결이 겹쳐도 같은 체결을 두 번 기록하지 않는다.
- SQLite WAL/FULL synchronous, 마이그레이션, 단일 엔진 lease, 주문 outbox, 감사·오류 로그를 사용한다.
- DB, 관리 토큰과 암호화 토큰 캐시는 권한 600으로 저장한다.
- 클라우드 웹에는 Basic 인증을 적용하고 엔진 관리 토큰과 증권사 비밀값은 브라우저 코드에 노출하지 않는다.

## 검증 결과

| 검증 | 결과 |
|---|---|
| 전체 TypeScript 타입 검사 | 통과 |
| Vitest | 12개 파일, 39개 테스트 전부 통과 |
| `trading-engine` 프로덕션 번들 | 통과 |
| Next.js 프로덕션 빌드 | 통과 |
| 엔진 Health/인증/Dashboard/Settings API 통합 테스트 | 통과 |
| Next 서버측 프록시와 관리 토큰 비노출 테스트 | 통과 |
| 클라우드 웹 인증 테스트 | 통과 |
| 전략 BUY/SELL/데이터 부족 테스트 | 통과 |
| 실제 주문가능현금·지정가·최대 보유 수 위험검사 | 통과 |
| SQLite 재개방 시 설정·보유·주문 outbox 복원 | 통과 |
| 누적체결 delta, REST/WS 중복, 취소 후 지연체결 | 통과 |
| 키움 조회 토큰 갱신 및 주문 자동 재전송 금지 | 통과 |
| 키움 `kt00009` 부분체결·확인된 취소 파서 | 통과 |
| KIS 거부 플래그와 계좌통보 포함 40 시세 슬롯 | 통과 |
| Docker Compose YAML | 통과 |
| 실제 로컬 DB | `quick_check=ok`, schema v2, engine lease 0 |
| DB와 관리 토큰 권한 | 600 |

이 Codex 실행 샌드박스는 로컬 TCP 포트 바인딩 자체를 `listen EPERM`으로 차단했다. 엔진은 실제 DB 마이그레이션·복구를 마치고 listen 단계까지 두 번 도달했으며, 실패 후 lease를 매번 0으로 회수했다. 따라서 이 환경에서는 `127.0.0.1:3100` 브라우저 화면을 실제 포트로 열 수 없었고, 동일 연결은 Fastify 주입 통합 테스트와 Next 서버측 프록시 테스트로 검증했다.

또한 증권사 API 키·계좌가 제공되지 않았으므로 토큰 발급, 실제 계좌조회, 장중 WebSocket, 모의 주문·체결을 실행했다고 주장하지 않는다. 이 부분은 아래 절차로 사용자의 양사 모의계좌에서 장중 검증해야 한다.

## 로컬 실행과 모의계좌 검증

1. macOS에서는 `outputs/KStock Trader.app`, Windows에서는 `outputs/KStock Trader (Windows).vbs`를 더블클릭한다.
2. 자동으로 열린 설정 화면에서 키움 모의와 KIS 모의의 App Key, Secret, 계좌번호를 입력한다. KIS는 계좌 상품코드와 HTS 사용자 ID도 입력하고 `저장하고 연결 시작`을 누른다.
3. 한 증권사만 먼저 환경을 `모의투자`로 두고 자동매매는 OFF 상태를 유지한다.
4. 연결 상태, 실제 마스킹 계좌, 코스피 감시 수, 일봉 적재 수, 스캔 진행률이 정상인지 확인한다.
5. 미체결·잔고·최근 체결이 증권사 모의 화면과 일치하는지 확인한다.
6. 매우 작은 한도로 자동매매를 켜고 신규주문, 부분체결, 취소, 재시작 복구를 확인한다.
7. 같은 절차를 다른 증권사에서 반복한 뒤 양쪽 동시 연결을 검증한다.
8. 모의 장중 검증을 끝내기 전에는 실전 환경을 켜지 않는다.

## 동일 코드의 클라우드 배포

`.env.example`을 기준으로 서버 `.env`를 작성한다. 최소한 `KSTOCK_ADMIN_TOKEN`, `KSTOCK_MASTER_KEY`, `KSTOCK_WEB_PASSWORD`와 사용할 계좌의 환경변수를 설정한다.

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f trading-engine
```

`trading-engine`과 웹은 동일 이미지를 빌드하고, `restart: unless-stopped`로 재시작된다. SQLite·주문·체결·보유·손익·설정·정지상태·암호화 토큰은 `kstock-data` 볼륨에 유지된다. 엔진 API는 외부 포트로 공개하지 않으며, 웹 앞에는 HTTPS reverse proxy를 둔다.

## 공식 API상 확인이 더 필요한 항목

- KIS 공식 `TTTC8494R` 실현손익 예제는 실전 TR만 명시한다. 모의 서버에서 거부되면 프로그램은 손익을 만들지 않고 해당 계좌를 `DEGRADED`로 유지한다.
- 키움 `ka10095`의 요청당 최대 종목 수는 공개 문서에 확정값이 없다. 기본값은 1이며, 모의계좌 ACK를 확인한 뒤 `KIWOOM_QUOTE_BATCH_SIZE`를 늘릴 수 있다.
- 개인용 WebSocket 제한상 코스피 전 종목을 동시에 틱 구독할 수는 없다. 구현은 공식 일괄조회로 전 종목을 순환 검사하고 보유·미체결·매도후보·매수후보에 실시간 슬롯을 우선 배정한다.
- Docker 실행 파일이 현재 Codex 호스트에 없어 컨테이너 자체 기동은 실행하지 못했고, Compose 구문과 두 프로덕션 이미지를 구성하는 애플리케이션 빌드까지 검증했다.

공식 확인 자료:

- [키움 REST API 공식 저장소](https://github.com/Kiwoom-Securities/Kiwoom-REST-API)
- [키움 공식 서비스 안내](https://openapi.kiwoom.com/intro/serviceInfo)
- [키움 kt00009 공식 예제](https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/main/examples/%EA%B5%AD%EB%82%B4%EC%A3%BC%EC%8B%9D/%EA%B3%84%EC%A2%8C/get_domestic_account_order_fill_status.py)
- [KIS Open API 공식 저장소](https://github.com/koreainvestment/open-trading-api)
- [KIS 당일 주문체결 공식 예제](https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_daily_ccld/inquire_daily_ccld.py)
- [KIS WebSocket 공식 예제](https://github.com/koreainvestment/open-trading-api/blob/main/examples_user/domestic_stock/domestic_stock_functions_ws.py)
