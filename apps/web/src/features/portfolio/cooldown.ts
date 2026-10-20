export const COOLDOWN_MS = 60_000;

/** serverTime minus the local clock at the moment the response arrived; add it to the local clock to get server time. */
export function serverOffsetMs(serverTimeIso: string, receivedAtMs: number): number {
  return Date.parse(serverTimeIso) - receivedAtMs;
}

export function msUntil(targetIso: string | null, localNowMs: number, offsetMs: number): number {
  if (targetIso === null) return 0;
  return Math.max(0, Date.parse(targetIso) - (localNowMs + offsetMs));
}

export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
