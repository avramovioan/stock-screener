import { describe, expect, it } from "vitest";
import {
  ACTIVE_JOBS_SQL,
  alterJobsSql,
  assertLocalCronTarget,
  LOCAL_DB_CONTAINER,
  parseJobIds,
} from "./local-cron.ts";

describe("local cron pause", () => {
  it("lists only the active jobs", () => {
    expect(ACTIVE_JOBS_SQL).toContain("from cron.job where active");
  });
  it("parses psql output into job ids", () => {
    expect(parseJobIds("1\r\n2\n\n7\n")).toEqual([1, 2, 7]);
    expect(parseJobIds("")).toEqual([]);
    expect(() => parseJobIds("1; drop table x")).toThrow(/unexpected/);
  });
  it("builds one alter_job call per job", () => {
    expect(alterJobsSql([1, 4], false)).toBe(
      "select cron.alter_job(1, active := false); select cron.alter_job(4, active := false);",
    );
    expect(alterJobsSql([4], true)).toBe("select cron.alter_job(4, active := true);");
  });
  it("only ever targets the local stack", () => {
    expect(() => assertLocalCronTarget("http://127.0.0.1:54321")).not.toThrow();
    expect(() => assertLocalCronTarget("http://localhost:54321")).not.toThrow();
    expect(() => assertLocalCronTarget("https://abc.supabase.co")).toThrow(/non-local/);
    expect(() => assertLocalCronTarget("http://127.0.0.1:54321", "prod-db")).toThrow(/non-local/);
    expect(LOCAL_DB_CONTAINER).toBe("supabase_db_stock-screener");
  });
});
