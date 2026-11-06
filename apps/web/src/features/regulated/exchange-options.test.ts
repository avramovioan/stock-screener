import { describe, expect, it } from "vitest";
import { countryName, filterExchanges, fold, groupExchanges } from "./exchange-options";
import { FIXTURE_EXCHANGES } from "./test-fixtures";

const mics = (list: readonly { mic: string }[]) => list.map((e) => e.mic);

describe("fold", () => {
  it("lower-cases and strips diacritics", () => {
    expect(fold("Deutsche Börse")).toBe("deutsche borse");
  });
});

describe("filterExchanges", () => {
  it("empty query returns all in MIC order", () => {
    expect(mics(filterExchanges(FIXTURE_EXCHANGES, ""))).toEqual([
      "XAMS",
      "XETB",
      "XETR",
      "XFRA",
      "XPAR",
      "XWBO",
    ]);
  });

  it("matches the MIC case-insensitively, including contains", () => {
    expect(mics(filterExchanges(FIXTURE_EXCHANGES, "xet"))).toEqual(["XETB", "XETR"]);
    expect(mics(filterExchanges(FIXTURE_EXCHANGES, "ETR"))).toEqual(["XETR", "XETB"]); // XETB by name only;
  });

  it("ranks MIC prefix, then MIC contains, then name contains", () => {
    const list = [
      { mic: "AXET", name: "A", country: "DE", segments: [], leis: [] },
      { mic: "ZZZZ", name: "Xeta something", country: "DE", segments: [], leis: [] },
      { mic: "XETR", name: "B", country: "DE", segments: [], leis: [] },
    ];
    expect(mics(filterExchanges(list, "xet"))).toEqual(["XETR", "AXET", "ZZZZ"]);
  });

  it("matches names without regard to diacritics", () => {
    expect(mics(filterExchanges(FIXTURE_EXCHANGES, "borse"))).toEqual(["XETR", "XFRA", "XWBO"]);
    expect(mics(filterExchanges(FIXTURE_EXCHANGES, "Börse"))).toEqual(["XETR", "XFRA", "XWBO"]);
  });

  it("returns nothing when no tier matches", () => {
    expect(filterExchanges(FIXTURE_EXCHANGES, "nope")).toEqual([]);
  });
});

describe("groupExchanges", () => {
  it("sections by English country name, ordered by it", () => {
    const groups = groupExchanges(FIXTURE_EXCHANGES, "");
    expect(groups.map((g) => g.countryName)).toEqual([
      "Austria",
      "France",
      "Germany",
      "Netherlands",
    ]);
    expect(groups.map((g) => g.country)).toEqual(["AT", "FR", "DE", "NL"]);
  });

  it("typing XET yields Germany with XETR", () => {
    const groups = groupExchanges(FIXTURE_EXCHANGES, "XET");
    const de = groups.find((g) => g.country === "DE");
    expect(de?.countryName).toBe("Germany");
    expect(mics(de?.exchanges ?? [])).toEqual(["XETR"]);
  });

  it("falls back to the code for an unknown region", () => {
    expect(countryName("DE")).toBe("Germany");
    expect(countryName("not a code")).toBe("not a code");
  });
});
