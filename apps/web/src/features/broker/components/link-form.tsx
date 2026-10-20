import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionResult, LinkInput } from "../broker-api";

export interface LinkFormProps {
  pending: boolean;
  /** another run is active: the form stays visible but cannot be submitted */
  disabled?: boolean;
  onSubmit(input: LinkInput): Promise<ActionResult | undefined> | void;
  fieldError: { field: string; message: string } | null;
  now: Date;
}

const isoDay = (d: Date, plusDays = 0) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + plusDays))
    .toISOString()
    .slice(0, 10);

function check(values: LinkInput, now: Date): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!/^[A-Za-z0-9._-]{8,200}$/.test(values.token))
    errors["token"] = "Enter the token exactly as shown by IBKR.";
  if (!/^\d{3,12}$/.test(values.queryId))
    errors["queryId"] = "The Query ID is a number of 3 to 12 digits.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.tokenExpiresOn) || values.tokenExpiresOn <= isoDay(now))
    errors["tokenExpiresOn"] = "The token expiry date must be in the future.";
  else if (values.tokenExpiresOn > isoDay(now, 366))
    errors["tokenExpiresOn"] = "IBKR tokens last at most one year.";
  return errors;
}

/** The token goes from this input to the broker-sync function over HTTPS and nowhere else: no storage, cleared right after submit. */
export function LinkForm({ pending, disabled = false, onSubmit, fieldError, now }: LinkFormProps) {
  const [token, setToken] = useState("");
  const [queryId, setQueryId] = useState("");
  const [expires, setExpires] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const shown = {
    ...errors,
    ...(fieldError === null ? {} : { [fieldError.field]: fieldError.message }),
  };

  return (
    <form
      className="space-y-3"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const values = { token: token.trim(), queryId: queryId.trim(), tokenExpiresOn: expires };
        const found = check(values, now);
        setErrors(found);
        if (Object.keys(found).length > 0 || pending || disabled) return;
        setToken("");
        void Promise.resolve(onSubmit(values)).catch(() => undefined);
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="flex-token">Flex token</Label>
        <Input
          id="flex-token"
          name="flex-token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          aria-invalid={shown["token"] !== undefined}
          aria-describedby={shown["token"] ? "flex-token-error" : undefined}
        />
        {shown["token"] ? (
          <p id="flex-token-error" role="alert" className="text-sm">
            {shown["token"]}
          </p>
        ) : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor="flex-query">Query ID</Label>
        <Input
          id="flex-query"
          name="flex-query"
          inputMode="numeric"
          autoComplete="off"
          value={queryId}
          onChange={(e) => setQueryId(e.target.value)}
          aria-invalid={shown["queryId"] !== undefined}
        />
        {shown["queryId"] ? (
          <p role="alert" className="text-sm">
            {shown["queryId"]}
          </p>
        ) : null}
      </div>
      <div className="space-y-1">
        <Label htmlFor="flex-expiry">Token expiry date</Label>
        <Input
          id="flex-expiry"
          name="flex-expiry"
          type="date"
          min={isoDay(now, 1)}
          max={isoDay(now, 366)}
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          aria-invalid={shown["tokenExpiresOn"] !== undefined}
        />
        {shown["tokenExpiresOn"] ? (
          <p role="alert" className="text-sm">
            {shown["tokenExpiresOn"]}
          </p>
        ) : null}
      </div>
      <Button type="submit" disabled={pending || disabled}>
        {pending ? "Linking..." : "Link"}
      </Button>
      {pending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Verifying with IBKR: this can take up to a minute.
        </p>
      ) : null}
    </form>
  );
}
