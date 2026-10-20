// biome-ignore-all lint/suspicious/noExplicitAny: recorded provider samples and PostgREST/function responses are untyped JSON
// Drives a scan against the local stack (spec 7.12).
//   bun run tools/run-local-scan.ts start    [--mode live|fixture] [--set day1] [--now 2026-10-15T07:00:00Z]
//   bun run tools/run-local-scan.ts tick     [--run <id|date>] [--max-minutes 60]
//   bun run tools/run-local-scan.ts status   [--run <id|date>]
//   bun run tools/run-local-scan.ts failures [--run <id|date>]
// Fixture mode reads recorded data and is refused unless SUPABASE_URL is 127.0.0.1 or localhost.
import {
  assertLocalUrl,
  callFunction,
  isTerminal,
  resolveStack,
  rest,
  sleep,
} from "./lib/local-stack.ts";

const [command, ...rest_] = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = rest_.indexOf(`--${name}`);
  return i >= 0 ? rest_[i + 1] : undefined;
};
const stack = resolveStack();

async function latestRun(run?: string): Promise<any> {
  const q =
    run === undefined
      ? "order=scan_date_local.desc&limit=1"
      : /^\d{4}-/.test(run)
        ? `scan_date_local=eq.${run}`
        : `id=eq.${run}`;
  return (
    await rest(
      stack,
      `scan_runs?select=id,scan_date_local,status,finished_at,coverage,universe_sizes&${q}`,
    )
  )[0];
}

switch (command) {
  case "start": {
    const mode = flag("mode") ?? "live";
    if (mode !== "live" && mode !== "fixture") throw new Error("--mode must be live or fixture");
    if (mode === "fixture") assertLocalUrl(stack.url);
    const body: Record<string, unknown> = { action: "start", provider_mode: mode };
    if (mode === "fixture") {
      body.fixture_set = flag("set") ?? "day1";
      body.now = flag("now") ?? "2026-10-15T07:00:00Z";
    }
    console.log(JSON.stringify(await callFunction(stack, "scan-control", body)));
    break;
  }
  case "tick": {
    const deadline = Date.now() + Number(flag("max-minutes") ?? "60") * 60_000;
    for (let n = 1; Date.now() < deadline; n++) {
      const res = await callFunction(stack, "worker-tick", { wait: true });
      const run = await latestRun(flag("run"));
      console.log(`tick ${n}: ${JSON.stringify(res.summary)} -> ${run?.status ?? "no run"}`);
      if (run !== undefined && isTerminal(run)) {
        console.log(
          JSON.stringify(
            { status: run.status, universe_sizes: run.universe_sizes, coverage: run.coverage },
            null,
            2,
          ),
        );
        process.exit(run.status === "failed" ? 2 : 0);
      }
      if (res.summary?.stoppedBecause === "idle") await sleep(15_000); // deferred jobs wait for not_before (breaker, siblings)
    }
    console.error("tick: max duration reached before the run became terminal");
    process.exit(3);
    break;
  }
  case "status": {
    const run = await latestRun(flag("run"));
    console.log(
      JSON.stringify(
        await callFunction(stack, "scan-control", {
          action: "status",
          ...(run ? { run: run.id } : {}),
        }),
        null,
        2,
      ),
    );
    break;
  }
  case "failures": {
    const run = await latestRun(flag("run"));
    console.log(
      JSON.stringify(
        await callFunction(stack, "scan-control", {
          action: "list_failures",
          ...(run ? { run: run.id } : {}),
        }),
        null,
        2,
      ),
    );
    break;
  }
  default:
    console.error(
      "usage: run-local-scan.ts start|tick|status|failures [--mode live|fixture] [--set day1|day2] [--now ISO] [--run id|date]",
    );
    process.exit(1);
}
