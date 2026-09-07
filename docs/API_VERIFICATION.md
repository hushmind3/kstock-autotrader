# 공식 API 검증 기록

확인 기준일: 2026-09-02

## 키움증권 REST API

- 실전 REST: `https://api.kiwoom.com`
- 모의 REST: `https://mockapi.kiwoom.com`
- OAuth: `POST /oauth2/token`, `au10001`, 24시간 토큰
- WebSocket: 실전 `wss://api.kiwoom.com:10000/api/dostk/websocket`, 모의 `wss://mockapi.kiwoom.com:10000/api/dostk/websocket`
- 코스피 종목목록: `ka10099`, `POST /api/dostk/stkinfo`, `mrkt_tp:"0"`
- 일봉: `ka10081`, `POST /api/dostk/chart`
- 복수 현재가: `ka10095`, 종목코드를 `|`로 구분
- 신규 매수/매도/정정/취소: `kt10000`/`kt10001`/`kt10002`/`kt10003`, `POST /api/dostk/ordr`
- 계좌 확인/미체결/체결/주문이력/잔고: `ka00001`, `ka10075`, `ka10076`, `kt00009`, `kt00018`
- `kt00009` 전체조회(`qry_tp:"0"`)의 공식 필드 `ord_no`, `orig_ord_no`, `ord_qty`, `cnfm_qty`, `cntr_no`, `cntr_qty`, `acpt_tp`, `mdfy_cncl_tp`로 재시작 주문 상태를 보수적으로 복원
- 실시간 체결/주문·체결/잔고/장운영 상태: `0B`, `00`, `04`, `0s`; 장운영 상태는 필드 `215`
- 공식 토큰 만료/검증 코드 `8005`, `8031`, `8103`은 조회 요청만 토큰 폐기 후 1회 재시도하며 주문 요청은 절대 자동 재전송하지 않음
- 실전 주문·조회 각 5회/초, 모의는 계좌·토큰·TR별 1회/초
- WebSocket 1세션, 실시간 시세 200종목

공식 출처:

- https://openapi.kiwoom.com/intro/serviceInfo
- https://openapi.kiwoom.com/guide/apiguide
- https://openapi.kiwoom.com/m/guide/apiguide?jobTpCode=01
- https://openapi.kiwoom.com/m/guide/apiguide?jobTpCode=07
- https://openapi.kiwoom.com/m/guide/apiguide?jobTpCode=08
- https://openapi.kiwoom.com/m/guide/apiguide?jobTpCode=13
- https://github.com/Kiwoom-Securities/Kiwoom-REST-API
- https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/main/examples/%EA%B5%AD%EB%82%B4%EC%A3%BC%EC%8B%9D/%EA%B3%84%EC%A2%8C/get_domestic_account_order_fill_status.py
- https://github.com/Kiwoom-Securities/Kiwoom-REST-API/blob/main/kiwoom_docs/%EC%8B%A4%EC%8B%9C%EA%B0%84%EC%8B%9C%EC%84%B8.md

공개 문서에서 `ka10095` 한 요청의 최대 종목 수와 일부 연속조회 페이지 크기는 확정할 수 없습니다. 어댑터는 설정값과 연속조회 헤더를 사용하며 실제 모의계좌 ACK로 확인해야 합니다.

## 한국투자증권 KIS Open API

- 실전 REST: `https://openapi.koreainvestment.com:9443`
- 모의 REST: `https://openapivts.koreainvestment.com:29443`
- OAuth: `POST /oauth2/tokenP`; 토큰 응답 만료시각 캐시, 짧은 주기 재발급 금지
- WebSocket 승인: `POST /oauth2/Approval`
- WebSocket: 실전 `ws://ops.koreainvestment.com:21000`, 모의 `ws://ops.koreainvestment.com:31000`
- 코스피 마스터: `https://new.real.download.dws.co.kr/common/master/kospi_code.mst.zip`
- 현재가/일봉/30종목 일괄현재가: `FHKST01010100`, `FHKST03010100`, `FHKST11300006`
- 국내 개장일 자동 확인: `CTCA0903R`, `/uapi/domestic-stock/v1/quotations/chk-holiday` (`opnd_yn`, 1일 1회)
- 현행 신규 매도/매수/정정취소: 실전 `TTTC0011U`/`TTTC0012U`/`TTTC0013U`, 모의 `VTTC0011U`/`VTTC0012U`/`VTTC0013U`
- 잔고/무미수 매수가능금액/실현손익/당일주문체결/정정취소가능: `TTTC8434R`, `TTTC8908R`, `TTTC8494R`, `TTTC0081R`, `TTTC0084R`와 문서화된 모의 `VTTC...`; 자동주문 가용현금은 실제 예수금과 무미수 매수가능금액 중 작은 값 사용
- 실시간 체결: `H0STCNT0`; 계좌 주문·체결: 실전 `H0STCNI0`, 모의 `H0STCNI9`
- 2026-04-20 공식 공지 기준 실전 REST 18회/초, 모의 1회/초, WebSocket 1세션, 실시간 등록 합계 41개
- 계좌통보 1슬롯을 예약하고 공식 공용 헬퍼의 제한도 따르므로 시세 구독 안전 상한은 40개
- WebSocket JSON `PINGPONG`은 WebSocket pong 제어 프레임으로 응답하고, 체결통보 `RFUS_YN`은 공식 `0=정상, 1=거부` 규칙으로 해석하며 미지 값은 실패 처리
- 당일 주문체결 REST는 주문별 누적 체결량으로 취급해 WebSocket 체결과 겹치는 양만 제거하고 차이만 원장에 기록

공식 출처:

- https://github.com/koreainvestment/open-trading-api
- https://github.com/koreainvestment/open-trading-api/blob/main/kis_devlp.yaml
- https://apiportal.koreainvestment.com/community/10000000-0000-0011-0000-000000000001/post/d0d1a83f-6f8d-4437-9700-6d26702fd989
- https://github.com/koreainvestment/open-trading-api/tree/main/examples_llm/domestic_stock
- https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_psbl_order/inquire_psbl_order.py
- https://github.com/koreainvestment/open-trading-api/blob/main/examples_llm/domestic_stock/inquire_daily_ccld/inquire_daily_ccld.py
- https://github.com/koreainvestment/open-trading-api/blob/main/examples_user/domestic_stock/domestic_stock_functions_ws.py
- https://github.com/koreainvestment/open-trading-api/blob/main/stocks_info/kis_kospi_code_mst.py

공식 저장소에는 과거 `TTTC080x` 계열 예제도 남아 있습니다. 구현은 현행 `examples_llm`의 `TTTC001x` 계열을 환경별 상수로 분리했으며, 모의 장중 테스트에서 다시 확인해야 합니다. WebSocket 해제 `tr_type`도 공식 자료에 `0`과 `2`가 혼재하므로 구성 상수로 둡니다. `TTTC8494R` 실현손익 조회는 공식 예제가 실전 TR만 제시하므로 모의 서버가 거부하면 값을 만들어내지 않고 해당 계좌를 `DEGRADED`로 유지합니다.
