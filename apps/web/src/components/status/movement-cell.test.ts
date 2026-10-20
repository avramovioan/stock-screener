import { describe, expect, it } from "vitest";
import { movementOf } from "./movement-cell";

describe("movementOf", () => {
  it("is null for a missing or non-finite value", () => {
    expect(movementOf(null)).toBeNull();
    expect(movementOf(undefined)).toBeNull();
    expect(movementOf(Number.NaN)).toBeNull();
  });
  it("derives direction and magnitude from the number, not from formatted text", () => {
    expect(movementOf(12.3456)).toEqual({ dir: "up", abs: "12.35", text: "+12.35%" });
    expect(movementOf(-0.5)).toEqual({ dir: "down", abs: "0.50", text: "-0.50%" });
    expect(movementOf(0.004)).toEqual({ dir: "flat", abs: "0.00", text: "0.00%" });
    expect(movementOf(-0.004)).toEqual({ dir: "flat", abs: "0.00", text: "0.00%" });
  });
});
