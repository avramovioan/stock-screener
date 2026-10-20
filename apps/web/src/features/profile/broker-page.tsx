import { DefaultDestinationCard } from "@/features/handoff/default-destination-card";
import { BrokerPanel } from "./panels/broker-panel";

export function ProfileBrokerPage() {
  return (
    <section aria-labelledby="page-title" className="max-w-2xl space-y-6">
      <h1 id="page-title" className="text-2xl font-semibold tracking-tight">
        Broker
      </h1>
      <BrokerPanel />
      <DefaultDestinationCard />
    </section>
  );
}
