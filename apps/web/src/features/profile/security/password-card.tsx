import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TextField } from "@/features/auth/components/text-field";
import { authApi } from "@/features/auth/default";
import {
  changePasswordSchema,
  fieldErrors,
  PASSWORD_MIN_LENGTH_TEXT,
} from "@/features/auth/schemas";

/** Rendered only for accounts that have an email identity (SecurityPage decides). */
export function PasswordCard({ email }: { email: string }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    setSuccess(false);
    const parsed = changePasswordSchema.safeParse({ current, password, confirm });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    const result = await authApi.changePassword(email, parsed.data.current, parsed.data.password);
    setPending(false);
    if (!result.ok) {
      setFailure(result.message);
      return;
    }
    setCurrent("");
    setPassword("");
    setConfirm("");
    setSuccess(true);
    toast.success("Your password was changed.");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change password</CardTitle>
        <CardDescription>We ask for your current password to confirm it is you.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate className="max-w-md space-y-4">
          <TextField
            id="current-password"
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={setCurrent}
            error={errors.current}
          />
          <TextField
            id="new-password"
            label="New password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            hint={PASSWORD_MIN_LENGTH_TEXT}
            error={errors.password}
          />
          <TextField
            id="confirm-password"
            label="Confirm new password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
            error={errors.confirm}
          />
          {failure ? (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          ) : null}
          {success ? <p role="status">Password updated.</p> : null}
          <Button type="submit" disabled={pending}>
            Change password
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
