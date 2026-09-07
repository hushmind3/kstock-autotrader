import type { ErrorRow } from "@/lib/api-types";

export interface ErrorPresentation {
  severityClass: "info" | "warning" | "error" | "fatal";
  severityLabel: string;
  message: string;
  detailLabel: string | null;
  technicalDetails: string | null;
}

export interface InsufficientDailyBars {
  symbol: string;
  available: number;
  required: number;
}

const severityLabels: Record<string, string> = {
  critical: "긴급",
  fatal: "긴급",
  error: "오류",
  warning: "주의",
  info: "안내",
};

const codeLabels: Record<string, string> = {
  BrokerIndeterminateError: "주문 결과 확인 필요",
  BrokerRejectedError: "증권사 요청 거절",
  BrokerTransportError: "증권사 통신 문제",
  ENGINE_LEASE_LOST: "중복 실행 방지",
  KiwoomProtocolError: "키움 응답 자료 확인",
  KISProtocolError: "한국투자 응답 자료 확인",
  TypeError: "프로그램 처리 문제",
};

const dailyBarFieldLabels: Record<string, string> = {
  date: "날짜",
  open: "시가",
  high: "고가",
  low: "저가",
  close: "종가",
  volume: "거래량",
};

/**
 * Stored broker errors are kept verbatim for auditing, but the operator UI
 * should explain them in plain Korean. This also localizes historical rows
 * written before Korean messages were introduced.
 */
export function presentError(row: ErrorRow): ErrorPresentation {
  const insufficient = insufficientDailyBars(row);
  if (insufficient) {
    const { symbol, available, required } = insufficient;
    return {
      severityClass: "info",
      severityLabel: "자료 부족",
      message: `종목 ${symbol}: 이동평균선을 계산할 과거 자료가 아직 부족합니다. 현재 ${available}일 / 필요 ${required}일이므로 자동매매 대상에서 잠시 제외했습니다.`,
      detailLabel: "주문 실패가 아닙니다",
      technicalDetails: technicalDetails(row),
    };
  }

  const dailyBar = row.message.match(/^daily-bars:([0-9A-Z]+):\s*(.+)$/i);
  if (dailyBar) {
    const [, symbol, rawDetail] = dailyBar;
    const malformedField = rawDetail.match(
      /^Kiwoom response omitted(?: or malformed)? required daily-bar (date|open|high|low|close|volume) field\.?$/i,
    );
    if (malformedField) {
      const field = dailyBarFieldLabels[malformedField[1]?.toLowerCase() ?? ""] ?? "필수";
      return {
        severityClass: "warning",
        severityLabel: "자료 확인",
        message: `종목 ${symbol}: 키움에서 받은 과거 시세의 ${field} 값이 없거나 형식이 맞지 않아 이번 검사에서 제외했습니다. 다음 자료 갱신 때 다시 확인합니다.`,
        detailLabel: "주문 실패가 아닙니다",
        technicalDetails: technicalDetails(row),
      };
    }
    if (/Broker returned no daily bars/i.test(rawDetail)) {
      return {
        severityClass: "warning",
        severityLabel: "자료 없음",
        message: `종목 ${symbol}: 증권사에서 과거 시세를 받지 못해 이번 검사에서 제외했습니다.`,
        detailLabel: "주문 실패가 아닙니다",
        technicalDetails: technicalDetails(row),
      };
    }
    if (/허용된 (?:API )?요청 개수를 초과|요청 한도|rate limit/i.test(rawDetail)) {
      return {
        severityClass: "warning",
        severityLabel: "잠시 대기",
        message: `종목 ${symbol}: 키움 조회 요청 한도에 잠시 걸렸습니다. 엔진이 다음 자료 갱신 때 다시 확인합니다.`,
        detailLabel: "주문 실패가 아닙니다",
        technicalDetails: technicalDetails(row),
      };
    }
    const localizedDetail = localizeKnownMessage(rawDetail);
    return {
      ...basePresentation(row),
      message: /[가-힣]/.test(localizedDetail)
        ? `종목 ${symbol}의 과거 시세를 확인하는 중 문제가 생겼습니다. ${localizedDetail}`
        : `종목 ${symbol}의 과거 시세를 확인하는 중 문제가 생겼습니다. 자세한 내용은 기술 정보에서 확인할 수 있습니다.`,
      technicalDetails: technicalDetails(row),
    };
  }

  const base = basePresentation(row);
  const localized = localizeContext(row.message);
  return {
    ...base,
    message: /[가-힣]/.test(localized)
      ? localized
      : "프로그램에서 확인이 필요한 문제가 발생했습니다. 자세한 내용은 기술 정보에서 확인할 수 있습니다.",
    technicalDetails:
      localized === row.message && /[가-힣]/.test(localized)
        ? base.technicalDetails
        : technicalDetails(row),
  };
}

export function insufficientDailyBars(row: ErrorRow): InsufficientDailyBars | null {
  const match = row.message.match(
    /^daily-bars:([0-9A-Z]+): Only (\d+) completed daily bars are available for [0-9A-Z]+; (\d+) required\.?$/i,
  );
  if (!match) return null;
  const available = Number(match[2]);
  const required = Number(match[3]);
  if (!Number.isSafeInteger(available) || !Number.isSafeInteger(required)) return null;
  return { symbol: match[1] ?? "알 수 없음", available, required };
}

export function formatOrderStatus(status: string): string {
  const labels: Record<string, string> = {
    QUEUED: "주문 대기",
    SENDING: "증권사로 전송 중",
    ACKED: "주문 접수",
    PARTIALLY_FILLED: "일부 체결",
    FILLED: "전량 체결",
    CANCEL_REQUESTED: "취소 요청 중",
    CANCELED: "취소 완료",
    AMEND_REQUESTED: "정정 요청 중",
    AMENDED: "정정 완료",
    REJECTED: "주문 거절",
    UNKNOWN: "처리 상태 확인 필요",
  };
  return labels[status.toUpperCase()] ?? "처리 상태 확인 필요";
}

function basePresentation(row: ErrorRow): ErrorPresentation {
  const normalizedSeverity = row.severity.toLowerCase();
  const severityClass =
    normalizedSeverity === "critical" || normalizedSeverity === "fatal"
      ? "fatal"
      : normalizedSeverity === "warning"
        ? "warning"
        : normalizedSeverity === "info"
          ? "info"
          : "error";
  const code = row.code?.trim();
  return {
    severityClass,
    severityLabel: severityLabels[normalizedSeverity] ?? "확인",
    message: row.message,
    detailLabel:
      code === undefined || code === "" || code === "Error"
        ? null
        : (codeLabels[code] ?? "세부 유형 확인"),
    technicalDetails:
      code === undefined || code === "" || code === "Error"
        ? null
        : technicalDetails(row),
  };
}

function technicalDetails(row: ErrorRow): string {
  const code = row.code?.trim();
  return code === undefined || code === "" || code === "Error"
    ? `원문: ${row.message}`
    : `기록 코드: ${code} · 원문: ${row.message}`;
}

function localizeContext(message: string): string {
  const mappings: Array<[RegExp, string]> = [
    [/^universe-sync:\s*/i, "코스피 종목 목록을 불러오는 중: "],
    [/^universe-refresh:\s*/i, "코스피 종목 목록을 갱신하는 중: "],
    [/^quote-sweep:([^:]+):\s*/i, "종목 $1의 현재가를 확인하는 중: "],
    [/^quote-subscriptions:\s*/i, "실시간 시세를 연결하는 중: "],
    [/^closed-market-unsubscribe:\s*/i, "장 종료 후 실시간 시세를 정리하는 중: "],
    [/^broker-startup:\s*/i, "증권사에 연결하는 중: "],
    [/^account-reconcile:\s*/i, "계좌 잔고와 주문을 맞추는 중: "],
    [/^scheduled-reconcile:\s*/i, "계좌 상태를 정기 확인하는 중: "],
    [/^order-maintenance:\s*/i, "미체결 주문을 확인하는 중: "],
    [/^order-dispatch:\s*/i, "주문을 전송하는 중: "],
    [/^market-calendar-(?:sync|refresh):\s*/i, "증권사 영업일을 확인하는 중: "],
    [/^external-strategy-load:\s*/i, "추가 전략 파일을 불러오는 중: "],
  ];
  let localized = message;
  for (const [pattern, replacement] of mappings) {
    if (!pattern.test(localized)) continue;
    localized = localized.replace(pattern, replacement);
    break;
  }
  return localizeKnownMessage(localized);
}

function localizeKnownMessage(message: string): string {
  return message
    .replace(
      /The broker returned an empty KOSPI universe\.?/gi,
      "증권사에서 코스피 종목 목록을 받지 못했습니다.",
    )
    .replace(/authentication denied/gi, "API 인증이 거절되었습니다. 키와 계좌 정보를 확인해 주세요.")
    .replace(/fetch failed/gi, "증권사 서버와 통신하지 못했습니다.");
}
