# 아키텍처와 데이터 흐름

```text
Next.js UI
   ↕ localhost server-side proxy
Trading Engine
   ├─ MarketDataCoordinator → SQLite bars/quotes → StrategyRunner
   ├─ Signal → RiskManager → order_intent/outbox → OrderDispatcher
   ├─ AccountRuntime[kiwoom:environment:account]
   └─ AccountRuntime[koreainvestment:environment:account]
          ↕
       REST + WebSocket
```

## 시작 순서

1. SQLite 무결성 검사, 마이그레이션, 단일 엔진 lease 획득
2. 영속된 전체 정지·증권사 설정 복원
3. OS 보안 저장소에서 선택 환경의 자격증명 로드
4. 증권사별 토큰 복원 또는 발급
5. WebSocket 연결과 계좌 이벤트 구독
6. 미체결·당일 주문이력·누적/개별 체결·실제 잔고 REST 대사
7. 코스피 종목목록 diff와 전략이 요구하는 확정 일봉 전체 적재
8. 전체 일봉 1차 필터, 일괄 현재가 순환조회, 후보 실시간 구독
9. 모든 안전 게이트가 정상일 때만 사용자가 자동매매를 명시적으로 허용

한 증권사 장애는 다른 증권사의 연결을 중지하지 않습니다. 단, SQLite 원장 장애와 전체 kill switch는 양쪽 모두를 fail-closed 처리합니다.

## 전략 경계

전략은 `requirements`, `validateConfig`, `evaluate`만 제공합니다. 입력은 확정 일봉, 현재가/누적거래량, 보유 여부이고 출력은 `BUY`, `SELL`, `HOLD`, `NOT_READY`와 이유 코드/계산지표입니다. 주문금액, 위험한도, 계좌조회, 현재 시각, 네트워크, DB는 전략의 책임이 아닙니다.

외부 전략은 별도 디렉터리의 JavaScript 모듈로 로드할 수 있습니다. 엔진은 전략 ID와 공통 계약만 사용하므로 자동주문 코드를 수정하지 않고 전략을 교체할 수 있습니다.

## 주문 일관성

신호가 주문이 되기 전에 `BEGIN IMMEDIATE` 트랜잭션에서 다음을 수행합니다.

1. 영속 kill switch와 계좌별 정지 재검사
2. 보유·미체결·당일 손실·시세 freshness 재검사
3. 계좌/종목 예산 예약
4. 입력 결정 해시를 사용한 중복 방지 키 삽입
5. 같은 계좌·종목·방향의 활성 주문 guard
6. outbox 저장

네트워크 주문은 커밋 후 전송됩니다. 타임아웃은 접수 여부가 불명확하므로 자동 재전송하지 않고 `UNKNOWN`으로 저장합니다. 재시작 시 전송 전 `QUEUED` intent는 만료하고, 전송을 시작한 outbox는 브로커의 미체결·당일 주문이력·체결·잔고와 대사해 해소될 때까지 해당 계좌의 신규주문을 차단합니다. 키움 취소처럼 취소주문 번호가 원주문과 다른 경우도 공식 원주문번호와 확인수량이 명시된 취소만 원주문에 반영합니다.

REST가 주문별 누적 체결을 반환하고 WebSocket이 개별 체결을 반환하는 경우 SQLite 원장은 동일 거래일·브로커주문번호의 기존 체결합을 기준으로 양의 차이만 추가합니다. 연결 단절, 미확인 장운영 상태, 누락된 일봉, `UNKNOWN` 주문, 실패한 outbox 중 하나라도 있으면 신규 주문은 차단됩니다.

## Windows, macOS와 Linux 클라우드

애플리케이션 코드는 하나입니다. 표준 HTTPS/WSS, Node.js, SQLite, `path` API를 사용하며 ActiveX/OCX가 없습니다. 운영체제 차이는 자격증명 저장소 구현과 서비스 등록뿐입니다.

- macOS: Keychain, 필요 시 `launchd`로 엔진 상시 실행
- Windows: Credential Manager, 필요 시 Task Scheduler/Windows Service wrapper로 엔진 상시 실행
- Linux/컨테이너: 환경변수 자격증명, 암호화 토큰 캐시, Docker 영속 볼륨, `restart: unless-stopped`

SQLite 경로와 데이터 디렉터리는 각각 `KSTOCK_DB_PATH`, `KSTOCK_DATA_DIR`로 주입합니다. 로컬 기본 경로를 서버 코드에 하드코딩하지 않았으며 로컬과 클라우드는 동일 마이그레이션·복구·주문 상태기계를 사용합니다. 단일 SQLite 볼륨에는 반드시 trading-engine 인스턴스 하나만 연결하며 DB lease가 이 조건을 재확인합니다.

절전 복귀나 네트워크 변경을 감지하면 신규주문을 먼저 막고 REST 대사와 WebSocket 재구독 후 정상 상태로 돌아갑니다.
