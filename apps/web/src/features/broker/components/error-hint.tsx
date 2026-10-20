import { flexErrorInfo } from "@core/flex-errors.ts";

/** IBKR / internal error code with its plain message and troubleshooting hint (same table the backend uses). */
export function ErrorHint({ code }: { code: number | null }) {
  if (code === null) return null;
  const info = flexErrorInfo(code);
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">{info.message}</p>
      <p className="text-muted-foreground">{info.hint}</p>
      <p className="text-xs text-muted-foreground">{`Error code ${code}`}</p>
    </div>
  );
}
