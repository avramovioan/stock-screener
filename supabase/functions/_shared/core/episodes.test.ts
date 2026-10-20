import { describe, expect, it } from "vitest";
import {
  type ActiveEpisode,
  type EpisodeAction,
  type Observation,
  stepDiscount,
  stepPremium,
} from "./episodes.ts";
import { applicableDiscountLine } from "./thresholds.ts";

/** A minimal simulator of what rank_signals does with the actions: apply them and stamp last_evaluated_session_date. */
class Sim {
  active: ActiveEpisode | null = null;
  private seq = 0;
  log: string[] = [];
  constructor(private readonly kind: ActiveEpisode["kind"] = "discount") {}

  discount(
    sessionDay: number,
    close: number,
    rank: number | null,
    lines: { "-3": number; "-4": number },
    canOpen = true,
    evaluable = true,
  ): EpisodeAction[] {
    const applicableLine = applicableDiscountLine(rank);
    const obs: Observation = {
      sessionDay,
      close,
      lineEnd: lines[applicableLine],
      canOpen,
      evaluable,
      rank,
      applicableLine,
    };
    const actions = stepDiscount(this.active, obs);
    this.apply(actions, sessionDay);
    return actions;
  }

  premium(
    sessionDay: number,
    close: number,
    lineEnd: number | null,
    kind: "premium1" | "premium2",
    canOpen = true,
    evaluable = true,
  ): EpisodeAction[] {
    const obs: Observation = {
      sessionDay,
      close,
      lineEnd,
      canOpen,
      evaluable,
      rank: null,
      applicableLine: kind === "premium1" ? "+1" : "+2",
    };
    const actions = stepPremium(this.active, obs, kind);
    this.apply(actions, sessionDay);
    return actions;
  }

  private apply(actions: EpisodeAction[], sessionDay: number): void {
    for (const a of actions) {
      if (a.type === "close") {
        this.log.push(`close:${a.reason}`);
        this.active = null;
      } else if (a.type === "open") {
        this.seq++;
        this.active = {
          id: `E${this.seq}`,
          kind: this.kind,
          mode: "worldwide",
          line: a.line,
          openedSessionDay: sessionDay,
          lastEvaluatedSessionDay: sessionDay,
        };
        this.log.push(
          `open:${a.line}:${a.reason}:${a.notify ? "notify" : "silent"}${a.continuesEpisodeId ? `:from ${a.continuesEpisodeId}` : ""}`,
        );
      } else if (this.active !== null) {
        this.active = { ...this.active, lastEvaluatedSessionDay: sessionDay };
      }
    }
  }
}

describe("stepDiscount: spec 8.8 example 1 (rank 8, applicable -3): entry, persistence, reset, re-entry", () => {
  it("replays the whole table", () => {
    const sim = new Sim();
    const line = (v: number) => ({ "-3": v, "-4": v - 20 });
    // D1 Mon 105.0 vs 100.2: not met
    expect(sim.discount(1, 105.0, 8, line(100.2))).toEqual([{ type: "noop", reason: "idle" }]);
    // D2 Tue 99.5 vs 100.3: open E1, notify
    expect(sim.discount(2, 99.5, 8, line(100.3))).toEqual([
      { type: "open", line: "-3", notify: true, reason: "new_entry" },
    ]);
    // D3 Wed 98.0 vs 100.4: noop
    expect(sim.discount(3, 98.0, 8, line(100.4))).toEqual([
      { type: "noop", reason: "still_below" },
    ]);
    // D4 Fri 97.5 vs 100.4: noop
    expect(sim.discount(5, 97.5, 8, line(100.4))).toEqual([
      { type: "noop", reason: "still_below" },
    ]);
    // D5 Sat scan, session Friday reused: noop (unchanged session)
    expect(sim.discount(5, 97.5, 8, line(100.4))).toEqual([
      { type: "noop", reason: "same_session" },
    ]);
    // D6 Mon 100.9 vs 100.5: close above the line resets
    expect(sim.discount(8, 100.9, 8, line(100.5))).toEqual([
      { type: "close", reason: "close_above_threshold" },
    ]);
    // D7 Tue 100.5 vs 100.6: a new episode E2
    expect(sim.discount(9, 100.5, 8, line(100.6))).toEqual([
      { type: "open", line: "-3", notify: true, reason: "new_entry" },
    ]);
    expect(sim.active?.id).toBe("E2");
  });

  it("a close exactly on the line still qualifies (no epsilon), a close equal to the line does not reset", () => {
    const sim = new Sim();
    expect(sim.discount(1, 100, 8, { "-3": 100, "-4": 80 })[0]?.type).toBe("open");
    expect(sim.discount(2, 100, 8, { "-3": 100, "-4": 80 })).toEqual([
      { type: "noop", reason: "still_below" },
    ]);
  });
});

describe("stepDiscount: rank never changes the trigger (A-51: every rank uses the -3 line)", () => {
  const lines = { "-3": 100, "-4": 90 };
  it("rank 10 and rank 11 open on the same -3 line with the same reason", () => {
    for (const rank of [10, 11, 40, null]) {
      const sim = new Sim();
      expect(sim.discount(1, 95, rank, lines)).toEqual([
        { type: "open", line: "-3", notify: true, reason: "new_entry" },
      ]);
    }
  });

  it("a rank 11+ security between -3 and -4 is a discount and stays one when its rank moves", () => {
    const sim = new Sim();
    expect(sim.discount(1, 95, 25, lines)[0]?.type).toBe("open"); // 90 < 95 <= 100: a card
    expect(sim.discount(2, 95, 9, lines)).toEqual([{ type: "noop", reason: "still_below" }]);
    expect(sim.discount(3, 95, 12, lines)).toEqual([{ type: "noop", reason: "still_below" }]);
    expect(sim.active?.id).toBe("E1");
  });

  it("an episode closes when the close rises above the -3 line, whatever the rank", () => {
    const sim = new Sim();
    sim.discount(1, 85, 40, lines);
    expect(sim.discount(2, 101, 40, lines)).toEqual([
      { type: "close", reason: "close_above_threshold" },
    ]);
  });

  it("does not label an entry as a rank change", () => {
    const sim = new Sim();
    sim.discount(1, 105, 12, lines);
    expect(sim.discount(2, 85, 3, lines)).toEqual([
      { type: "open", line: "-3", notify: true, reason: "new_entry" },
    ]);
  });
});

describe("stepDiscount: existing -4 episodes (opened before A-51) are closed or continued", () => {
  const lines = { "-3": 100, "-4": 90 };
  const legacy: ActiveEpisode = {
    id: "L1",
    kind: "discount",
    mode: "worldwide",
    line: "-4",
    openedSessionDay: 1,
    lastEvaluatedSessionDay: 1,
  };
  const obs = (close: number, canOpen = true): Observation => ({
    sessionDay: 2,
    close,
    lineEnd: lines["-3"],
    canOpen,
    evaluable: true,
    rank: 30,
    applicableLine: "-3",
  });

  it("still at or below -3: close it and continue silently on the -3 line", () => {
    expect(stepDiscount(legacy, obs(88))).toEqual([
      { type: "close", reason: "threshold_changed" },
      { type: "open", line: "-3", notify: false, reason: "continuation", continuesEpisodeId: "L1" },
    ]);
  });

  it("between -4 and -3 (the old rule would have closed it): it continues, no re-notification", () => {
    const actions = stepDiscount(legacy, obs(95));
    expect(actions[1]).toMatchObject({ line: "-3", notify: false, reason: "continuation" });
  });

  it("above -3: it simply closes", () => {
    expect(stepDiscount(legacy, obs(101))).toEqual([
      { type: "close", reason: "threshold_changed" },
    ]);
  });

  it("cannot continue when Tier 2 fails: it only closes", () => {
    expect(stepDiscount(legacy, obs(88, false))).toEqual([
      { type: "close", reason: "threshold_changed" },
    ]);
  });
});

describe("stepDiscount: canOpen false path (can close, cannot open) and not-evaluable days", () => {
  it("meeting the condition but failing Tier 2 does not open", () => {
    const sim = new Sim();
    expect(sim.discount(1, 3.0, 40, { "-3": 5, "-4": -1.7 }, false)).toEqual([
      { type: "noop", reason: "idle" },
    ]);
  });

  it("example 5: rank 40, lower2 end -1.70, close 3.0: no discount and cannot open", () => {
    const sim = new Sim();
    expect(sim.discount(1, 3.0, 40, { "-3": 0.5, "-4": -1.7 }, false)).toEqual([
      { type: "noop", reason: "idle" },
    ]);
  });

  it("an active episode still closes when the close rises above the line even if canOpen is now false", () => {
    const sim = new Sim();
    sim.discount(1, 95, 8, { "-3": 100, "-4": 80 });
    expect(sim.discount(2, 101, 8, { "-3": 100, "-4": 80 }, false)).toEqual([
      { type: "close", reason: "close_above_threshold" },
    ]);
  });

  it("example 7: a failed data day (lineEnd null) neither opens nor closes", () => {
    const sim = new Sim();
    sim.discount(1, 95, 8, { "-3": 100, "-4": 80 });
    const obs: Observation = {
      sessionDay: 2,
      close: 150,
      lineEnd: null,
      canOpen: false,
      evaluable: true,
      rank: 8,
      applicableLine: "-3",
    };
    expect(stepDiscount(sim.active, obs)).toEqual([{ type: "noop", reason: "not_evaluable" }]);
    expect(stepDiscount(null, { ...obs, close: 1 })).toEqual([
      { type: "noop", reason: "not_evaluable" },
    ]);
  });

  it("a non-finite close is not evaluable", () => {
    const obs: Observation = {
      sessionDay: 2,
      close: Number.NaN,
      lineEnd: 100,
      canOpen: true,
      evaluable: true,
      rank: 8,
      applicableLine: "-3",
    };
    expect(stepDiscount(null, obs)).toEqual([{ type: "noop", reason: "not_evaluable" }]);
  });
});

describe("stepDiscount: idempotent replays", () => {
  it("running the same scan twice yields no further actions at every step of example 1", () => {
    const sim = new Sim();
    const lines = (v: number) => ({ "-3": v, "-4": v - 20 });
    const steps: Array<[number, number, number]> = [
      [1, 105, 100.2],
      [2, 99.5, 100.3],
      [3, 98, 100.4],
      [4, 100.9, 100.5],
      [5, 100.5, 100.6],
    ];
    for (const [d, c, l] of steps) {
      sim.discount(d, c, 8, lines(l));
      const again = sim.discount(d, c, 8, lines(l));
      expect(again.every((a) => a.type === "noop")).toBe(true);
    }
  });

  it("a closed episode is not reopened by a replay of the closing session", () => {
    const sim = new Sim();
    sim.discount(1, 95, 8, { "-3": 100, "-4": 80 });
    sim.discount(2, 101, 8, { "-3": 100, "-4": 80 }); // closes
    expect(sim.discount(2, 101, 8, { "-3": 100, "-4": 80 })).toEqual([
      { type: "noop", reason: "idle" },
    ]);
  });

  it("an older session than the last evaluation is a no-op (data never regresses an episode)", () => {
    const sim = new Sim();
    sim.discount(5, 95, 8, { "-3": 100, "-4": 80 });
    expect(sim.discount(4, 120, 8, { "-3": 100, "-4": 80 })).toEqual([
      { type: "noop", reason: "same_session" },
    ]);
    expect(sim.active).not.toBeNull();
  });
});

describe("stepPremium: spec 8.8 example 4 (+1 = 120, +2 = 140)", () => {
  it("replays P1..P7 with independent premium1 and premium2 episodes", () => {
    const p1 = new Sim("premium1");
    const p2 = new Sim("premium2");
    const run = (day: number, close: number) => ({
      a1: p1.premium(day, close, 120, "premium1"),
      a2: p2.premium(day, close, 140, "premium2"),
    });
    expect(run(1, 119)).toEqual({
      a1: [{ type: "noop", reason: "idle" }],
      a2: [{ type: "noop", reason: "idle" }],
    });
    expect(run(2, 121)).toEqual({
      a1: [{ type: "open", line: "+1", notify: true, reason: "new_entry" }],
      a2: [{ type: "noop", reason: "idle" }],
    });
    expect(run(3, 125)).toEqual({
      a1: [{ type: "noop", reason: "still_above" }],
      a2: [{ type: "noop", reason: "idle" }],
    });
    expect(run(4, 141)).toEqual({
      a1: [{ type: "noop", reason: "still_above" }],
      a2: [{ type: "open", line: "+2", notify: true, reason: "new_entry" }],
    });
    // P5 130: premium2 closes, premium1 stays active
    expect(run(5, 130)).toEqual({
      a1: [{ type: "noop", reason: "still_above" }],
      a2: [{ type: "close", reason: "close_below_upper_line" }],
    });
    // P6 118: premium1 closes
    expect(run(6, 118)).toEqual({
      a1: [{ type: "close", reason: "close_below_upper_line" }],
      a2: [{ type: "noop", reason: "idle" }],
    });
    // P7 121: a new premium1 episode
    expect(run(7, 121).a1).toEqual([
      { type: "open", line: "+1", notify: true, reason: "new_entry" },
    ]);
  });

  it("equality qualifies for opening and a close equal to the line does not reset", () => {
    const sim = new Sim("premium1");
    expect(sim.premium(1, 120, 120, "premium1")[0]?.type).toBe("open");
    expect(sim.premium(2, 120, 120, "premium1")).toEqual([{ type: "noop", reason: "still_above" }]);
  });

  it("canOpen false never opens; a not-evaluable day changes nothing; the same session is a no-op", () => {
    const sim = new Sim("premium1");
    expect(sim.premium(1, 130, 120, "premium1", false)).toEqual([{ type: "noop", reason: "idle" }]);
    sim.premium(2, 130, 120, "premium1");
    expect(sim.premium(3, 100, null, "premium1")).toEqual([
      { type: "noop", reason: "not_evaluable" },
    ]);
    expect(sim.premium(2, 100, 120, "premium1")).toEqual([
      { type: "noop", reason: "same_session" },
    ]);
    expect(sim.active).not.toBeNull();
  });
});

describe("evaluable flag: stale or suspect data is never a reset", () => {
  const lines = { "-3": 100, "-4": 80 };
  it("discount: active episode, evaluable false, close above the line -> noop, episode survives", () => {
    const sim = new Sim();
    sim.discount(1, 95, 8, lines);
    expect(sim.discount(2, 150, 8, lines, true, false)).toEqual([
      { type: "noop", reason: "not_evaluable" },
    ]);
    expect(sim.active).not.toBeNull();
  });
  it("discount: no episode, evaluable false, close below the line -> nothing opens", () => {
    const sim = new Sim();
    expect(sim.discount(1, 50, 8, lines, true, false)).toEqual([
      { type: "noop", reason: "not_evaluable" },
    ]);
    expect(sim.active).toBeNull();
  });
  it("premium: both directions are noops when not evaluable", () => {
    const sim = new Sim("premium1");
    expect(sim.premium(1, 130, 120, "premium1", true, false)).toEqual([
      { type: "noop", reason: "not_evaluable" },
    ]);
    expect(sim.active).toBeNull();
    sim.premium(2, 130, 120, "premium1");
    expect(sim.premium(3, 100, 120, "premium1", true, false)).toEqual([
      { type: "noop", reason: "not_evaluable" },
    ]);
    expect(sim.active).not.toBeNull();
  });
  it("example 7 replay: a stale day in the middle causes no duplicate notify-open on recovery", () => {
    const sim = new Sim();
    sim.discount(1, 95, 8, lines); // opens E1
    sim.discount(2, 150, 8, lines, true, false); // stale day, close would reset
    const recovered = sim.discount(3, 96, 8, lines);
    expect(recovered).toEqual([{ type: "noop", reason: "still_below" }]);
    expect(sim.log.filter((l) => l.startsWith("open:"))).toHaveLength(1);
    expect(sim.active?.id).toBe("E1");
  });
});
