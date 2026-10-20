import { assert, assertEquals } from "@std/assert";
import {
  containsDtd,
  type FlexStatement,
  parseDecimal,
  parseFlexDate,
  parseFlexDateTime,
  parseFlexStatement,
  requiredSectionReport,
} from "./flex-parse.ts";

const XML = await Deno.readTextFile(
  new URL("./fixtures/flex/activity-sample.xml", import.meta.url),
);

function statement(xml = XML, opts?: { attributeNamePrefix?: string }): FlexStatement {
  const res = parseFlexStatement(xml, opts);
  if (!res.ok) throw new Error(`parse failed: ${res.code} ${res.message}`);
  return res.statement;
}

const omitRaw = <T extends { raw: Record<string, string> }>(row: T): Omit<T, "raw"> => {
  const { raw: _raw, ...rest } = row;
  return rest;
};

Deno.test("parseDecimal handles dot and comma decimals, thousands separators, parentheses and rejects garbage", () => {
  const table: Array<[string | null, number | null]> = [
    ["12.50", 12.5],
    ["-0.39", -0.39],
    ["1,234.56", 1234.56],
    ["1.234,56", 1234.56],
    ["12,5", 12.5],
    ["1,234", 1234],
    ["1,234,567", 1234567],
    ["1.234.567", 1234567],
    ["(5.25)", -5.25],
    ["+3", 3],
    ["0", 0],
    [" 7 ", 7],
    ["", null],
    ["-", null],
    [null, null],
    ["abc", null],
    ["1,2,3", null],
    ["1e5", null],
  ];
  for (const [input, expected] of table) assertEquals(parseDecimal(input), expected, String(input));
});

Deno.test("parseFlexDate and parseFlexDateTime accept yyyyMMdd and yyyy-MM-dd and fail closed on ambiguous formats", () => {
  assertEquals(parseFlexDate("20261014"), "2026-10-14");
  assertEquals(parseFlexDate("2026-10-14"), "2026-10-14");
  assertEquals(parseFlexDate("20261014;093015"), "2026-10-14");
  assertEquals(parseFlexDate("20260230"), null);
  assertEquals(parseFlexDate("14/10/2026"), null);
  assertEquals(parseFlexDate("10/14/2026"), null);
  assertEquals(parseFlexDate(""), null);
  assertEquals(parseFlexDateTime("20261008;110500"), { date: "2026-10-08", time: "11:05:00" });
  assertEquals(parseFlexDateTime("2026-10-08 11:05:00"), { date: "2026-10-08", time: "11:05:00" });
  assertEquals(parseFlexDateTime("20261008"), { date: "2026-10-08", time: null });
  assertEquals(parseFlexDateTime("garbage"), null);
});

Deno.test("statement header and account information", () => {
  const s = statement();
  assertEquals(
    {
      accountId: s.accountId,
      baseCurrency: s.baseCurrency,
      accountType: s.accountType,
      fromDate: s.fromDate,
      toDate: s.toDate,
      whenGenerated: s.whenGenerated,
    },
    {
      accountId: "U1234567",
      baseCurrency: "EUR",
      accountType: "Individual",
      fromDate: "2026-09-15",
      toDate: "2026-10-14",
      whenGenerated: "2026-10-15T03:05:12Z",
    },
  );
});

Deno.test("open positions: SUMMARY rows only, USD and GBP, enriched from Financial Instrument Information, LOT rows counted as ignored", () => {
  const s = statement();
  assertEquals(s.positions.length, 2);
  const [aapl, shel] = s.positions.map(omitRaw);
  assertEquals(aapl, {
    conid: 100001,
    symbol: "AAPL",
    isin: "US0378331005",
    description: "APPLE INC",
    assetClass: "STK",
    subCategory: "COMMON",
    listingExchange: "NASDAQ",
    currency: "USD",
    fxRateToBase: 0.92,
    quantity: 10,
    multiplier: 1,
    markPrice: 230,
    positionValue: 2300,
    openPrice: 200.17,
    costBasisPrice: 200.17,
    costBasisMoney: 2001.7,
    fifoPnlUnrealized: 298.3,
    percentOfNav: 12.5,
    levelOfDetail: "SUMMARY",
    reportDate: "2026-10-14",
    openDateTime: null,
  });
  assertEquals(shel, {
    conid: 100002,
    symbol: "SHEL",
    isin: "GB00BP6MXD84",
    description: "VANG S&P500 USDD",
    assetClass: "STK",
    subCategory: "COMMON",
    listingExchange: "LSE",
    currency: "GBP",
    fxRateToBase: 1.15,
    quantity: 100,
    multiplier: 1,
    markPrice: 27.35,
    positionValue: 2735,
    openPrice: 25,
    costBasisPrice: 25,
    costBasisMoney: 2500,
    fifoPnlUnrealized: 235,
    percentOfNav: 17.1,
    levelOfDetail: "SUMMARY",
    reportDate: "2026-10-14",
    openDateTime: null,
  });
  assertEquals(s.ignored["positions:LOT"], 1);
});

Deno.test("unknown attributes are preserved in raw", () => {
  assertEquals(statement().positions[0]?.raw["futureField"], "kept-in-raw");
});

Deno.test("trades: executions and closed lots are different levels of detail; a partial fill is two executions of one order", () => {
  const s = statement();
  assertEquals(s.trades.length, 3);
  assertEquals(s.closedLots.length, 2);
  const [fill1, fill2, sell] = s.trades.map(omitRaw);
  assertEquals(fill1, {
    tradeId: "1001001",
    execId: "0000f001.6710a001.01.01",
    orderId: "5001",
    conid: 100001,
    isin: "US0378331005",
    symbol: "AAPL",
    description: "APPLE INC",
    listingExchange: "NASDAQ",
    exchange: "NASDAQ",
    currency: "USD",
    fxRateToBase: 0.92,
    tradeDate: "2026-10-09",
    tradeTime: "09:30:01",
    settleDate: "2026-10-12",
    buySell: "BUY",
    quantity: 6,
    tradePrice: 199.5,
    tradeMoney: 1197,
    proceeds: -1197,
    taxes: 0,
    ibCommission: -1,
    ibCommissionCurrency: "USD",
    netCash: -1198,
    costBasis: 1198,
    fifoPnlRealized: 0,
    openClose: "O",
    orderType: "LMT",
    reportDate: "2026-10-14",
  });
  assertEquals(fill2?.tradeId, "1001002");
  assertEquals(fill2?.orderId, "5001");
  assertEquals(fill2?.execId, "0000f001.6710a002.01.01");
  assertEquals(
    [fill2?.quantity, fill2?.tradePrice, fill2?.ibCommission, fill2?.netCash, fill2?.tradeTime],
    [4, 200.75, -0.7, -803.7, "09:30:07"],
  );
  assertEquals(sell, {
    tradeId: "2002001",
    execId: "0000f002.6709b001.01.01",
    orderId: "5002",
    conid: 100002,
    isin: "GB00BP6MXD84",
    symbol: "SHEL",
    description: "SHELL PLC",
    listingExchange: "LSE",
    exchange: "LSE",
    currency: "GBP",
    fxRateToBase: 1.15,
    tradeDate: "2026-10-08",
    tradeTime: "11:05:00",
    settleDate: "2026-10-12",
    buySell: "SELL",
    quantity: -4,
    tradePrice: 26.5,
    tradeMoney: -106,
    proceeds: 106,
    taxes: 0,
    ibCommission: -0.4,
    ibCommissionCurrency: "GBP",
    netCash: 105.6,
    costBasis: -101,
    fifoPnlRealized: 4.6,
    openClose: "C",
    orderType: "LMT",
    reportDate: "2026-10-14",
  });
});

Deno.test("closed lots of one partial sale are two lots whose P/L adds up to the execution P/L (no double counting)", () => {
  const s = statement();
  const [a, b] = s.closedLots.map(omitRaw);
  assertEquals(a, {
    conid: 100002,
    symbol: "SHEL",
    currency: "GBP",
    fxRateToBase: 1.15,
    openDateTime: "2026-01-15T09:30:00Z",
    closeDate: "2026-10-08",
    closingTradeId: "2002001",
    quantity: 3,
    costBasis: 75,
    proceeds: 79.5,
    fifoPnlRealized: 4.2,
  });
  assertEquals(b, {
    conid: 100002,
    symbol: "SHEL",
    currency: "GBP",
    fxRateToBase: 1.15,
    openDateTime: "2026-02-20T10:15:00Z",
    closeDate: "2026-10-08",
    closingTradeId: "2002001",
    quantity: 1,
    costBasis: 26,
    proceeds: 26.5,
    fifoPnlRealized: 0.4,
  });
  const lots = Math.round(s.closedLots.reduce((n, l) => n + l.fifoPnlRealized, 0) * 100) / 100;
  assertEquals(lots, s.trades[2]?.fifoPnlRealized);
});

Deno.test("cash transactions: dividend, its withholding tax, a deposit and a fee with categories and verbatim types", () => {
  const s = statement();
  assertEquals(s.cashTransactions.map(omitRaw), [
    {
      occurredAt: "2026-10-10T20:25:00Z",
      reportDate: "2026-10-14",
      currency: "USD",
      fxRateToBase: 0.92,
      amount: 2.6,
      typeRaw: "Dividends",
      category: "dividend",
      conid: 100001,
      isin: "US0378331005",
      symbol: "AAPL",
      description: "AAPL(US0378331005) CASH DIVIDEND USD 0.26 PER SHARE (Ordinary Dividend)",
      tradeId: null,
      code: null,
    },
    {
      occurredAt: "2026-10-10T20:25:00Z",
      reportDate: "2026-10-14",
      currency: "USD",
      fxRateToBase: 0.92,
      amount: -0.39,
      typeRaw: "Withholding Tax",
      category: "withholding_tax",
      conid: 100001,
      isin: "US0378331005",
      symbol: "AAPL",
      description: "AAPL(US0378331005) CASH DIVIDEND USD 0.26 PER SHARE - US TAX",
      tradeId: null,
      code: null,
    },
    {
      occurredAt: "2026-09-16T12:00:00Z",
      reportDate: "2026-09-16",
      currency: "EUR",
      fxRateToBase: 1,
      amount: 5000,
      typeRaw: "Deposits/Withdrawals",
      category: "deposit_withdrawal",
      conid: null,
      isin: null,
      symbol: null,
      description: "Electronic Fund Transfer",
      tradeId: null,
      code: null,
    },
    {
      occurredAt: "2026-10-01T00:00:00Z",
      reportDate: "2026-10-01",
      currency: "EUR",
      fxRateToBase: 1,
      amount: -2,
      typeRaw: "Other Fees",
      category: "fee",
      conid: null,
      isin: null,
      symbol: null,
      description: "Market data fee",
      tradeId: null,
      code: null,
    },
  ]);
});

Deno.test("conversion rates, NAV rows, corporate actions, transfers, dividend accruals and instruments", () => {
  const s = statement();
  assertEquals(s.fxRates, [
    { rateDate: "2026-10-14", fromCcy: "USD", toCcy: "EUR", rate: 0.92 },
    { rateDate: "2026-10-14", fromCcy: "GBP", toCcy: "EUR", rate: 1.15 },
  ]);
  assertEquals(s.nav, [
    {
      reportDate: "2026-10-13",
      currency: "EUR",
      cash: 1000,
      stock: 8800.55,
      other: 0,
      total: 9800.55,
    },
    {
      reportDate: "2026-10-14",
      currency: "EUR",
      cash: 1000,
      stock: 8950.2,
      other: 0,
      total: 9950.2,
    },
  ]);
  assertEquals(s.corporateActions.map(omitRaw), [
    {
      kind: "corporate_action",
      occurredAt: "2026-09-30T20:25:00Z",
      conid: 100003,
      symbol: "XYZ",
      typeRaw: "FS",
      quantity: 10,
      amount: 0,
      currency: "USD",
      code: null,
    },
  ]);
  assertEquals(s.transfers, []);
  assertEquals(s.dividendAccruals.map(omitRaw), [
    {
      exDate: "2026-10-08",
      payDate: "2026-10-10",
      conid: 100001,
      symbol: "AAPL",
      currency: "USD",
      quantity: 10,
      grossRate: 0.26,
      grossAmount: 2.6,
      tax: -0.39,
      netAmount: 2.21,
    },
  ]);
  assertEquals(s.instruments.map(omitRaw), [
    {
      conid: 100001,
      symbol: "AAPL",
      isin: "US0378331005",
      subCategory: "COMMON",
      listingExchange: "NASDAQ",
      description: "APPLE INC",
    },
    {
      conid: 100002,
      symbol: "SHEL",
      isin: "GB00BP6MXD84",
      subCategory: "COMMON",
      listingExchange: "LSE",
      description: "SHELL PLC",
    },
  ]);
  assertEquals(s.sections.transfers, true);
});

Deno.test("both attribute-name-prefix variants and any attribute case give the same result", () => {
  const base = statement();
  assertEquals(
    statement(XML, { attributeNamePrefix: "" }).positions.map(omitRaw),
    base.positions.map(omitRaw),
  );
  assertEquals(
    statement(XML, { attributeNamePrefix: "@" }).trades.map(omitRaw),
    base.trades.map(omitRaw),
  );
  // upper-case every attribute name except those of the XML declaration on the first line
  const [declaration, ...body] = XML.split("\n");
  const shouting = [
    declaration,
    ...body.map((line) =>
      line.replaceAll(/ (\w+)="/g, (_m, name: string) => ` ${name.toUpperCase()}="`),
    ),
  ].join("\n");
  assertEquals(statement(shouting).closedLots.map(omitRaw), base.closedLots.map(omitRaw));
  assertEquals(statement(shouting).positions.map(omitRaw), base.positions.map(omitRaw));
});

Deno.test("an execution without ibExecID uses trade:<tradeID> as its key; neither id is a parse error", () => {
  const noExec = XML.replace(' ibExecID="0000f001.6710a001.01.01"', "");
  assertEquals(statement(noExec).trades[0]?.execId, "trade:1001001");
  const neither = noExec.replace(' tradeID="1001001"', "");
  const res = parseFlexStatement(neither);
  assertEquals(res.ok, false);
  if (!res.ok)
    assertEquals(
      res.issues.some((i) => i.section === "trades" && i.field === "ibExecID|tradeID"),
      true,
    );
});

Deno.test("fail closed: a missing required attribute is a parse error and nothing is returned", () => {
  const res = parseFlexStatement(
    XML.replace(
      ' conid="100002" isin="GB00BP6MXD84" reportDate="20261014" position="100"',
      ' isin="GB00BP6MXD84" reportDate="20261014" position="100"',
    ),
  );
  assertEquals(res.ok, false);
  if (!res.ok) {
    assertEquals(res.code, "parse_error");
    assertEquals(res.issues[0], { section: "openPositions", row: 2, field: "conid" });
  }
});

Deno.test("fail closed: bad XML, no statement, two statements, ambiguous dates", () => {
  assertEquals(parseFlexStatement("<FlexQueryResponse><FlexStatements>").ok, false);
  const none = parseFlexStatement(
    '<FlexQueryResponse><FlexStatements count="0"></FlexStatements></FlexQueryResponse>',
  );
  assertEquals(none.ok === false && none.code, "no_statement");
  const two = XML.replace(
    "</FlexStatements>",
    '<FlexStatement accountId="U7" fromDate="20260101" toDate="20260102"></FlexStatement></FlexStatements>',
  );
  const res = parseFlexStatement(two);
  assertEquals(res.ok === false && res.code, "multiple_statements");
  const ambiguous = parseFlexStatement(
    XML.replaceAll('reportDate="20261014"', 'reportDate="14/10/2026"'),
  );
  assertEquals(ambiguous.ok, false);
});

Deno.test("required sections: the fixture is complete; removing a section or a field is reported with the exact label", () => {
  const ok = requiredSectionReport(statement());
  assertEquals(
    ok.every((r) => r.present && r.missingFields.length === 0),
    true,
  );
  assertEquals(
    ok.map((r) => r.section),
    [
      "Account Information",
      "Open Positions",
      "Trades",
      "Cash Transactions",
      "Currency Conversion Rate",
      "Financial Instrument Information",
    ],
  );

  const noCash = XML.replace(/<CashTransactions>[\s\S]*<\/CashTransactions>/, "");
  const report = requiredSectionReport(statement(noCash));
  assertEquals(report.find((r) => r.section === "Cash Transactions")?.present, false);

  const noCostBasis = XML.replaceAll(/ costBasisMoney="[^"]*"/g, "");
  const fields = requiredSectionReport(statement(noCostBasis)).find(
    (r) => r.section === "Open Positions",
  );
  assertEquals(fields?.missingFields, ["Cost Basis Money"]);
});

Deno.test("a statement with sells but without Closed Lots warns that realized P/L cannot be summed from lots", () => {
  const noLots = XML.replaceAll(/<Lot [^>]*\/>/g, "");
  assertEquals(statement(noLots).warnings.includes("closed_lots_not_included"), true);
  assertEquals(statement().warnings, []);
});

Deno.test("DOCTYPE and ENTITY declarations are rejected as invalid_xml in any case", () => {
  const withDoctype = XML.replace(
    "<FlexQueryResponse",
    '<!DOCTYPE foo [<!ENTITY xxe "boom">]><FlexQueryResponse',
  );
  const a = parseFlexStatement(withDoctype);
  assertEquals(a.ok === false && a.code, "invalid_xml");
  const b = parseFlexStatement(
    XML.replace("<FlexQueryResponse", "<!doctype foo><FlexQueryResponse"),
  );
  assertEquals(b.ok === false && b.code, "invalid_xml");
  assertEquals(containsDtd("<! DOCTYPE foo>"), true);
  assertEquals(containsDtd("<!  ENTITY a 'b'>"), true);
  assertEquals(containsDtd("<!-- s DOCTYPE -->"), false);
  const c = parseFlexStatement(XML.replace("<FlexStatements", '<!ENTITY a "b"><FlexStatements'));
  assertEquals(c.ok === false && c.code, "invalid_xml");
});

Deno.test("attribute entity references are decoded once, in the parsed value and in raw", () => {
  const res = parseFlexStatement(
    XML.replace(
      'description="VANG S&amp;P500 USDD" conid="100002"',
      'description="A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos; &#38; &#x26; &#x1F600; &amp;amp;" conid="100002"',
    ),
  );
  assert(res.ok);
  const want = "A & B <C> \"D\" 'E' & & \u{1F600} &amp;";
  assertEquals(res.statement.positions[1]?.description, want);
  assertEquals(res.statement.positions[1]?.raw["description"], want);
});

Deno.test("an invalid numeric reference is left as written", () => {
  const res = parseFlexStatement(
    XML.replace(
      'description="VANG S&amp;P500 USDD" conid="100002"',
      'description="X &#0; &#x110000; Y" conid="100002"',
    ),
  );
  assert(res.ok);
  assertEquals(res.statement.positions[1]?.description, "X &#0; &#x110000; Y");
});

Deno.test("a section named SecuritiesInfo with SecurityInfo rows is reported as Financial Instrument Information, present and complete", () => {
  assertEquals(XML.includes("<SecuritiesInfo>"), true);
  const report = requiredSectionReport(statement()).find(
    (r) => r.section === "Financial Instrument Information",
  );
  assertEquals(report?.present, true);
  assertEquals(report?.missingFields, []);
});

Deno.test("open positions take listingExchange and subCategory from the SecurityInfo row with the same conid", () => {
  const [aapl, shel] = statement().positions;
  assertEquals(
    [aapl?.conid, aapl?.listingExchange, aapl?.subCategory],
    [100001, "NASDAQ", "COMMON"],
  );
  assertEquals([shel?.conid, shel?.listingExchange, shel?.subCategory], [100002, "LSE", "COMMON"]);
});
