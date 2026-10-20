import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { ActionResult, BrokerSnapshot, LinkInput } from "./broker-api";
import { runActive } from "./broker-view";
import { brokerApi } from "./default";

export const BROKER_KEY = ["broker", "status"] as const;

/** Table reads under RLS (safe columns only). Polls every 5 s ONLY while a sync run is active (spec 14.2). */
export function useBrokerSnapshot() {
  return useQuery<BrokerSnapshot>({
    queryKey: BROKER_KEY,
    queryFn: () => brokerApi.readSnapshot(),
    staleTime: 60_000,
    refetchInterval: (q) => (runActive(q.state.data?.run ?? null) ? 5000 : false),
  });
}

export function useBrokerActions() {
  const qc = useQueryClient();
  // The Flex token never becomes mutation `variables` (those stay in the MutationCache): it is handed over through this ref and
  // consumed inside `mutationFn`.
  const pendingLink = useRef<LinkInput | null>(null);
  const [linkResult, setLinkResult] = useState<ActionResult | undefined>(undefined);
  const resets = useRef<Array<() => void>>([]);
  const settled = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: BROKER_KEY }),
      qc.invalidateQueries({ queryKey: ["portfolio"] }),
      qc.invalidateQueries({ queryKey: ["analytics"] }),
    ]);
  };
  /** A new action clears the outcome notices of the other actions. */
  const startOthers = (self: "link" | "test" | "sync" | "unlink") => {
    if (self !== "link") setLinkResult(undefined);
    const [link, test, sync, unlink] = resets.current;
    if (self !== "link") link?.();
    if (self !== "test") test?.();
    if (self !== "sync") sync?.();
    if (self !== "unlink") unlink?.();
  };

  const link = useMutation({
    mutationFn: async (): Promise<ActionResult> => {
      const input = pendingLink.current;
      pendingLink.current = null;
      if (input === null) throw new Error("No link request.");
      return brokerApi.link(input);
    },
    gcTime: 0,
    onMutate: () => startOthers("link"),
    onSettled: async () => {
      pendingLink.current = null;
      link.reset();
      await settled();
    },
  });
  const test = useMutation({
    mutationFn: () => brokerApi.test(),
    onMutate: () => startOthers("test"),
    onSettled: settled,
  });
  const sync = useMutation({
    mutationFn: () => brokerApi.sync(),
    onMutate: () => startOthers("sync"),
    onSettled: settled,
  });
  const unlink = useMutation({
    mutationFn: (o: { deleteData: boolean }) => brokerApi.unlink(o),
    onMutate: () => startOthers("unlink"),
    onSettled: settled,
  });
  resets.current = [() => setLinkResult(undefined), test.reset, sync.reset, unlink.reset];

  return {
    link: {
      isPending: link.isPending,
      data: linkResult,
      async submit(input: LinkInput): Promise<ActionResult> {
        pendingLink.current = input;
        const result = await link.mutateAsync();
        setLinkResult(result);
        return result;
      },
    },
    test,
    sync,
    unlink,
  };
}
