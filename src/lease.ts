/**
 * When a container should stop on its own, apart from ordinary idle sleep. Pure, so it can be tested alone.
 *
 * - A lease is one tap on "Keep awake": 1 or 2 hours, renewed only by another tap. It holds off idle sleep.
 *   At its end the container takes a snapshot and stops, even with a browser tab open.
 * - With no lease, a container stops once nobody has tapped for the cap (FORGOTTEN_TAB_CAP_HOURS), counted from
 *   its start or the last tap. An open tab holds a WebSocket, which otherwise blocks idle sleep forever.
 */
export const WARNING_MS = 10 * 60_000;
export const DEFAULT_CAP_HOURS = 12;

export interface LeaseState {
  /** When the current lease ends. */
  leaseUntil?: number;
  lastTapAt?: number;
  startedAt?: number;
}

export interface LeaseView {
  /** When this container is due to stop on its own. */
  stopsAt: number | null;
  reason: "lease" | "cap" | null;
  /** Inside the last 10 minutes. */
  warn: boolean;
  due: boolean;
}

/** Only 1 or 2 hours, exactly. Anything else in a request is refused. */
export function parseLeaseHours(value: unknown): 1 | 2 | null {
  return value === 1 || value === 2 ? value : null;
}

/** Always counted from the tap, so renewing can't stack past 2 hours from now. */
export function nextLease(state: LeaseState, hours: 1 | 2, now: number): Required<LeaseState> {
  return { leaseUntil: now + hours * 3_600_000, lastTapAt: now, startedAt: state.startedAt ?? now };
}

export function capMs(value: string | undefined): number {
  const hours = Number(value);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_CAP_HOURS) * 3_600_000;
}

export function leaseView(state: LeaseState, cap: number, now: number): LeaseView {
  let stopsAt: number | null = null;
  let reason: LeaseView["reason"] = null;
  if (state.leaseUntil) {
    stopsAt = state.leaseUntil;
    reason = "lease";
  } else if (state.startedAt) {
    stopsAt = Math.max(state.startedAt, state.lastTapAt ?? 0) + cap;
    reason = "cap";
  }
  return { stopsAt, reason, warn: stopsAt !== null && now >= stopsAt - WARNING_MS, due: stopsAt !== null && now >= stopsAt };
}
