import {
  DESTINATION_LABELS,
  DESTINATIONS,
  type Destination,
  isDestination,
} from "@core/handoff.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useDefaultDestination, useSaveDefaultDestination } from "./hooks";

/** Profile -> Broker: the iBot destination that the hand-off pre-selects (A-39). Saved to profiles.default_destination under the user's own RLS row. */
export function DefaultDestinationCard() {
  const current = useDefaultDestination();
  const save = useSaveDefaultDestination();
  const value: Destination = isDestination(current.data) ? current.data : "IBIS2";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Default destination</CardTitle>
        <CardDescription>
          Pre-selected in the Trade on IBKR hand-off. IBIS2 is your own practice and is not listed
          in IBKR's public catalogue: if iBot rejects it, choose IBIS (Xetra).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <Label htmlFor="default-destination">Default destination</Label>
        <select
          id="default-destination"
          className="h-11 w-full max-w-md rounded-md border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={value}
          disabled={current.isLoading || save.isPending}
          onChange={(e) => {
            if (isDestination(e.target.value)) save.mutate(e.target.value);
          }}
        >
          {DESTINATIONS.map((d) => (
            <option key={d} value={d}>{`${d} — ${DESTINATION_LABELS[d]}`}</option>
          ))}
        </select>
        <p role="status" className="min-h-5 text-sm">
          {save.isPending ? "Saving…" : save.isSuccess ? "Saved" : ""}
        </p>
        {current.isError || save.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {save.isError
              ? "Could not save your default destination."
              : "Could not load your default destination."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
