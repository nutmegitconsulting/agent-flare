import { describe, expect, it } from "vitest";
import { capMs, DEFAULT_CAP_HOURS, leaseView, nextLease, parseLeaseHours, WARNING_MS } from "../../src/lease";

const HOUR = 3_600_000;
const CAP = 12 * HOUR;
const T = 1_000_000_000_000;

describe("lease", () => {
  it("ends at its expiry, warning 10 minutes before", () => {
    const state = { leaseUntil: T + HOUR, startedAt: T };
    expect(leaseView(state, CAP, T)).toEqual({ stopsAt: T + HOUR, reason: "lease", warn: false, due: false });
    expect(leaseView(state, CAP, T + HOUR - WARNING_MS).warn).toBe(true);
    expect(leaseView(state, CAP, T + HOUR - WARNING_MS).due).toBe(false);
    expect(leaseView(state, CAP, T + HOUR).due).toBe(true);
  });
  it("ends even if the container has run past the cap, and a lease isn't extended by the cap", () => {
    const view = leaseView({ leaseUntil: T + HOUR, startedAt: T - 20 * HOUR }, CAP, T);
    expect(view.due).toBe(false);
    expect(view.stopsAt).toBe(T + HOUR);
  });
});

describe("lease length", () => {
  it("is only 1 or 2 hours", () => {
    expect(parseLeaseHours(1)).toBe(1);
    expect(parseLeaseHours(2)).toBe(2);
    for (const bad of [0, 3, 8, 1.5, -1, "1", "2", null, undefined, [1], { hours: 1 }, true]) expect(parseLeaseHours(bad)).toBeNull();
  });
  it("can't stack: a renewal counts from the tap, never from the old end", () => {
    const first = nextLease({ startedAt: T }, 2, T);
    const again = nextLease(first, 2, T + HOUR);
    expect(again.leaseUntil).toBe(T + 3 * HOUR);
    expect(again.leaseUntil - (T + HOUR)).toBe(2 * HOUR);
    expect(nextLease(first, 1, T + 1000).leaseUntil).toBe(T + 1000 + HOUR);
    expect(again.startedAt).toBe(T);
    expect(again.lastTapAt).toBe(T + HOUR);
  });
});

describe("forgotten-tab cap", () => {
  it("counts from the start, with no tap", () => {
    expect(leaseView({ startedAt: T }, CAP, T + CAP - 1).due).toBe(false);
    expect(leaseView({ startedAt: T }, CAP, T + CAP)).toMatchObject({ reason: "cap", due: true });
  });
  it("counts from the last tap once there is one", () => {
    const state = { startedAt: T, lastTapAt: T + 5 * HOUR };
    expect(leaseView(state, CAP, T + CAP).due).toBe(false);
    expect(leaseView(state, CAP, T + 5 * HOUR + CAP).due).toBe(true);
  });
  it("warns before stopping", () => {
    expect(leaseView({ startedAt: T }, CAP, T + CAP - WARNING_MS).warn).toBe(true);
  });
  it("has nothing to say before a container has started", () => {
    expect(leaseView({}, CAP, T)).toEqual({ stopsAt: null, reason: null, warn: false, due: false });
  });
  it("reads the config var, defaulting on anything unusable", () => {
    expect(capMs("6")).toBe(6 * HOUR);
    expect(capMs("0.5")).toBe(HOUR / 2);
    for (const bad of [undefined, "", "0", "-1", "soon"]) expect(capMs(bad)).toBe(DEFAULT_CAP_HOURS * HOUR);
  });
});
