import type { SignalKind, ThresholdLine, UniverseMode } from "./thresholds.ts";

export interface ActiveEpisode {
  id: string;
  kind: SignalKind;
  mode: UniverseMode;
  line: ThresholdLine;
  openedSessionDay: number;
  lastEvaluatedSessionDay: number;
}

export interface Observation {
  sessionDay: number;
  close: number;
  /** True only when the series is fresh, not suspect and the channel was computed for this session (8.1/8.3). False: the step is a no-op, never a reset. */
  evaluable: boolean;
  /** lineEnd null => the channel is not computable or the data is not evaluable (stale, suspect): the step is a no-op. */
  lineEnd: number | null;
  /** Tier 1 member (not carried forward) AND Tier 2 valid AND fresh AND not suspect. */
  canOpen: boolean;
  rank: number | null;
  applicableLine: ThresholdLine; // discount only: always "-3" since A-51 (rank decides the tag, not the trigger)
}

export type EpisodeAction =
  | { type: "noop"; reason: string }
  | {
      type: "open";
      line: ThresholdLine;
      notify: boolean;
      reason: "new_entry" | "continuation";
      continuesEpisodeId?: string;
    }
  | {
      type: "close";
      reason: "close_above_threshold" | "threshold_changed" | "close_below_upper_line";
    };

/**
 * Discount state machine for one security in one mode (8.2, 8.3). Pure over (active episode, observation).
 *  - not evaluable (lineEnd null or a non-finite close): neither opens nor closes.
 *  - same session and same applicable line as the last evaluation: no-op (re-runs and weekend replays).
 *  - an episode opened on another line (a pre-A-51 "-4" one) is closed as threshold_changed and continued silently on the -3 line
 *    when the condition still holds. Rank never changes the line, so a rank change never closes or opens anything.
 */
export function stepDiscount(active: ActiveEpisode | null, obs: Observation): EpisodeAction[] {
  if (!obs.evaluable || obs.lineEnd === null || !Number.isFinite(obs.close))
    return [{ type: "noop", reason: "not_evaluable" }];
  if (
    active !== null &&
    obs.sessionDay <= active.lastEvaluatedSessionDay &&
    obs.applicableLine === active.line
  ) {
    return [{ type: "noop", reason: "same_session" }];
  }
  const inDiscount = obs.close <= obs.lineEnd;

  if (active === null) {
    if (inDiscount && obs.canOpen) {
      return [{ type: "open", line: obs.applicableLine, notify: true, reason: "new_entry" }];
    }
    return [{ type: "noop", reason: "idle" }];
  }

  if (active.line === obs.applicableLine) {
    return inDiscount
      ? [{ type: "noop", reason: "still_below" }]
      : [{ type: "close", reason: "close_above_threshold" }];
  }

  // the active episode is on another line (opened before A-51 on "-4")
  if (inDiscount && obs.canOpen) {
    return [
      { type: "close", reason: "threshold_changed" },
      {
        type: "open",
        line: obs.applicableLine,
        notify: false,
        reason: "continuation",
        continuesEpisodeId: active.id,
      },
    ];
  }
  return [{ type: "close", reason: "threshold_changed" }];
}

/** Premium state machine (+1 uses end.upper1, +2 uses end.upper2: the caller passes the matching lineEnd). */
export function stepPremium(
  active: ActiveEpisode | null,
  obs: Observation,
  kind: "premium1" | "premium2",
): EpisodeAction[] {
  if (!obs.evaluable || obs.lineEnd === null || !Number.isFinite(obs.close))
    return [{ type: "noop", reason: "not_evaluable" }];
  if (active !== null && obs.sessionDay <= active.lastEvaluatedSessionDay)
    return [{ type: "noop", reason: "same_session" }];
  const line: ThresholdLine = kind === "premium1" ? "+1" : "+2";
  const above = obs.close >= obs.lineEnd;
  if (active === null) {
    return above && obs.canOpen
      ? [{ type: "open", line, notify: true, reason: "new_entry" }]
      : [{ type: "noop", reason: "idle" }];
  }
  return above
    ? [{ type: "noop", reason: "still_above" }]
    : [{ type: "close", reason: "close_below_upper_line" }];
}
