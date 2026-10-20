import { json, requireCronSecret } from "@adapters/http.ts";
import type { DispatchResult } from "./dispatch.ts";

export interface HandlerDeps {
  cronSecret: string;
  run(): Promise<DispatchResult>;
}

export async function handleNotifyDispatch(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method !== "POST")
    return json({ error: "method_not_allowed" }, { status: 405, headers: { allow: "POST" } });
  const denied = await requireCronSecret(req, deps.cronSecret);
  if (denied !== null) return denied;
  const result = await deps.run();
  return json({ ok: true, ...result });
}
