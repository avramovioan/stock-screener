import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export function DividendToggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange(v: boolean): void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch id="include-dividends" checked={checked} onCheckedChange={onChange} />
      <Label htmlFor="include-dividends">Include net dividends in combined performance</Label>
    </div>
  );
}
