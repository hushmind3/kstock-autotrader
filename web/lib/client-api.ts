export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const payload = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `요청 실패 (${response.status})`);
  return payload;
}

export function koreanErrorMessage(cause: unknown, fallback: string): string {
  const message = cause instanceof Error ? cause.message : String(cause ?? "");
  return /[가-힣]/.test(message) ? message : fallback;
}

export function formatWon(value: number | null | undefined, showSign = false): string {
  if (value === null || value === undefined) return "—";
  const sign = showSign && value > 0 ? "+" : "";
  return `${sign}${new Intl.NumberFormat("ko-KR").format(value)}원`;
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("ko-KR").format(value);
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}
