import { describe, expect, it } from "vitest";
import { SERVER_SECRET_NAMES } from "./secret-names.ts";
import { scanText } from "./secret-scan.ts";

describe("SERVER_SECRET_NAMES", () => {
  it.each(SERVER_SECRET_NAMES)("the bundle scan flags %s", (name) => {
    const findings = scanText(`var x = "${name}";`);
    expect(findings.map((f) => f.rule)).toContain("forbidden-name");
  });
  it("covers the names the code actually reads", () => {
    for (const name of [
      "RATE_LIMIT_SALT",
      "FLEX_ENC_KEY_V1",
      "VAPID_PRIVATE_KEY",
      "CRON_SHARED_SECRET",
      "GEMINI_API_KEY",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
    ]) {
      expect(scanText(name).length, name).toBeGreaterThan(0);
    }
  });
});
