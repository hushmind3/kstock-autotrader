# 한국투자증권 국내 선물·옵션 어댑터

현물용 `@kstock/broker-kis`와 주문·포지션 타입을 공유하지 않는 별도 어댑터입니다. 운영체제 전용 모듈 없이 Node.js REST/WebSocket만 사용하므로 macOS, Windows, Linux 서버에서 같은 코드로 실행됩니다.

## 안전한 주문 의미

`direction`과 `positionEffect`를 반드시 함께 지정합니다.

- `LONG + OPEN` → 매수 신규
- `LONG + CLOSE` → 매도 청산
- `SHORT + OPEN` → 매도 신규
- `SHORT + CLOSE` → 매수 청산

KIS 주문 전문에는 신규/청산을 별도로 강제하는 필드가 없습니다. 따라서 어댑터가 주문 직전에 실제 선물 잔고를 조회합니다. 신규 주문이 반대 포지션을 상계하게 되거나 청산 수량이 실제 포지션보다 많으면 주문을 보내지 않습니다. 같은 종목 주문은 직렬화하지만, 다른 프로그램이 같은 계좌에서 동시에 주문하면 조회와 주문 사이에 잔고가 바뀔 수 있으므로 상위 엔진에서도 단일 주문 주체를 유지해야 합니다.

계좌상품코드는 공식 예제의 국내 선물·옵션 코드 `03`만 허용합니다. 현물 코드 `01`은 즉시 거부합니다.

## 공식 지원 범위와 제한

- 실전 주간 주문: `TTTO1101U`
- 실전 야간 주문: `STTN1101U`
- 실전 주간/야간 정정·취소: `TTTO1103U`, `TTTN1103U`
- 주간/야간 잔고: `CTFO6118R`, `CTFN6118R`
- 주간/야간 주문·체결 조회: `TTTO5201R`, `STTN5201R`
- 주간 실시간 체결통보: `H0IFCNI0`
- 야간 선물/옵션 체결통보: `H0MFCNI0`, `H0EUCNI0`
- 지수선물 주간/야간 실시간 체결가: `H0IFCNT0`, `H0MFCNT0`
- 지수옵션 주간/야간 실시간 체결가: `H0IOCNT0`, `H0EUCNT0`

공식 예제는 모의투자 야간 주문 TR ID와 모의 선물 실시간 시세를 제공하지 않습니다. 이 어댑터는 해당 기능을 흉내 내지 않고 호출 전에 거부합니다. 계좌 요약 응답에 예수금 또는 증거금 필드가 없는 경우 `0`을 만들지 않으며, 해당 값은 생략하고 `unavailableFields`에 기록합니다.

## 근거 문서

- [KIS 공식 국내 선물·옵션 REST 예제](https://github.com/koreainvestment/open-trading-api/blob/main/examples_user/domestic_futureoption/domestic_futureoption_functions.py)
- [KIS 공식 국내 선물·옵션 WebSocket 예제](https://github.com/koreainvestment/open-trading-api/blob/main/examples_user/domestic_futureoption/domestic_futureoption_functions_ws.py)
- [KIS 공식 국내 선물·옵션 실행 예제](https://github.com/koreainvestment/open-trading-api/blob/main/examples_user/domestic_futureoption/domestic_futureoption_examples.py)

이 패키지는 아직 현물 자동매매 엔진에 연결하지 않았습니다. 실제 연결 때에는 선물 전용 계좌/포지션 원장과 현물 헤지 원장을 분리해야 합니다.
