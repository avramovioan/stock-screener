import { registerSW } from "virtual:pwa-register";
import { toast } from "sonner";

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      toast("Update available", {
        description: "A new version is ready.",
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "Reload",
          onClick: () => {
            void updateSW(true);
          },
        },
      });
    },
  });
  void import("@/features/notifications/sw-messages").then(
    async ({ attachSubscriptionChangeListener }) => {
      const { createNotificationsApi } = await import("@/features/notifications/notifications-api");
      const { supabase } = await import("@/lib/supabase");
      const { resubscribeKeepingTopics } = await import("@/features/notifications/topic-store");
      attachSubscriptionChangeListener(navigator.serviceWorker, (subscription) =>
        resubscribeKeepingTopics(createNotificationsApi(supabase), subscription),
      );
    },
  );
}
