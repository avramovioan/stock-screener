import { describe, expect, it } from "vitest";
import { displayTicker, US_EXCHANGE_CODES } from "./ticker.ts";

describe("displayTicker", () => {
  it("strips the Yahoo exchange suffix on a non-US exchange", () => {
    expect(displayTicker("RMS.PA", "PAR")).toBe("RMS");
    expect(displayTicker("ASML.AS", "AMS")).toBe("ASML");
    expect(displayTicker("7203.T", "JPX")).toBe("7203");
    expect(displayTicker("ROG.SW", "EBS")).toBe("ROG");
  });

  it("keeps the symbol on every US exchange code", () => {
    for (const code of ["NYQ", "NMS", "NGM", "NCM", "ASE", "PCX", "BTS", "NYS", "NAS"]) {
      expect(US_EXCHANGE_CODES.has(code)).toBe(true);
      expect(displayTicker("BRK.B", code)).toBe("BRK.B");
    }
  });

  it("keeps dash forms and symbols without a suffix", () => {
    expect(displayTicker("BRK-B", "NYQ")).toBe("BRK-B");
    expect(displayTicker("BF-B", "PAR")).toBe("BF-B");
    expect(displayTicker("MCD", "NYQ")).toBe("MCD");
    expect(displayTicker("SAP", "GER")).toBe("SAP");
  });

  it("strips only the part after the last dot", () => {
    expect(displayTicker("A.B.L", "LSE")).toBe("A.B");
  });

  it("never returns an empty symbol", () => {
    expect(displayTicker(".PA", "PAR")).toBe(".PA");
  });
});
