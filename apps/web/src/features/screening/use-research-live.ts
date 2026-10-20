import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { supabase } from "@/lib/supabase";
import { queryKeys } from "./hooks";

const DEBOUNCE_MS = 1000;

type Subscription = object;

/** The part of the supabase client the hook uses (narrow so tests can pass a stand-in). */
export interface LiveClient {
  channel(name: string): {
    on(
      type: "postgres_changes",
      filter: { event: "INSERT" | "UPDATE"; schema: string; table: string },
      callback: () => void,
    ): unknown;
    subscribe(callback?: (status: string) => void): unknown;
  };
  removeChannel(channel: never): unknown;
}

/**
 * Every open Overview hears when any research report is queued, started or finished (Realtime on
 * public.research_reports) and refreshes the feed and the quota, at most once a second. If the channel
 * cannot be opened nothing breaks: the feed polling in useTodaysDiscounts is the fallback.
 */
export function useResearchLive(client: LiveClient = supabase as unknown as LiveClient): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.discounts });
        void queryClient.invalidateQueries({ queryKey: queryKeys.researchQuota });
      }, DEBOUNCE_MS);
    };
    let channel: Subscription | undefined;
    try {
      const opened = client.channel("research-reports-live");
      for (const event of ["INSERT", "UPDATE"] as const) {
        opened.on(
          "postgres_changes",
          { event, schema: "public", table: "research_reports" },
          refresh,
        );
      }
      opened.subscribe();
      channel = opened;
    } catch {
      channel = undefined;
    }
    return () => {
      clearTimeout(timer);
      if (channel) {
        try {
          void client.removeChannel(channel as never);
        } catch {
          // nothing to clean up
        }
      }
    };
  }, [client, queryClient]);
}
