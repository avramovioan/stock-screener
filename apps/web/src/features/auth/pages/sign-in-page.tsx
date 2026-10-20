import { type FormEvent, type RefObject, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AccessStatus, AuthFailure } from "../api";
import { AUTH_LINK, AuthCard } from "../components/auth-card";
import { TextField } from "../components/text-field";
import { authApi } from "../default";
import {
  createPasswordSchema,
  emailSchema,
  fieldErrors,
  PASSWORD_MIN_LENGTH_TEXT,
  signInPasswordSchema,
} from "../schemas";
import { useFocusOnError } from "../use-focus-on-error";
import { useNextParam } from "../use-next-param";
import { useRedirectWhenSignedIn } from "../use-redirect-when-signed-in";

type Step = "email" | AccessStatus;

/** "friend@example.com · Change": the address of step 2 and the way back to step 1. */
function EmailLine({ email, onChange }: { email: string; onChange: () => void }) {
  return (
    <p className="text-sm text-muted-foreground">
      <span className="break-all">{email}</span>
      {" · "}
      <button type="button" className={AUTH_LINK} onClick={onChange}>
        Change
      </button>
    </p>
  );
}

function FailureText({
  failure,
  alertRef,
}: {
  failure: AuthFailure | null;
  alertRef: RefObject<HTMLParagraphElement | null>;
}) {
  if (!failure) return null;
  return (
    <p ref={alertRef} tabIndex={-1} role="alert" className="text-sm text-destructive outline-none">
      {failure.message}
    </p>
  );
}

/**
 * Invite-only sign-in. Step 1 asks for the e-mail only; the invite list decides the next step:
 * create a password, sign in, or "Not possible yet" (no reason is given).
 */
export function SignInPage() {
  const next = useNextParam();
  useRedirectWhenSignedIn(next);

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<AuthFailure | null>(null);
  const [pending, setPending] = useState(false);

  const alertRef = useFocusOnError(errors, failure, ["email", "password", "confirm"]);

  function back() {
    setStep("email");
    setPassword("");
    setConfirm("");
    setErrors({});
    setFailure(null);
  }

  async function onContinue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setErrors({ email: parsed.error.issues[0]?.message ?? "Enter a valid email address." });
      return;
    }
    setErrors({});
    setPending(true);
    const result = await authApi.checkAccess(parsed.data);
    setPending(false);
    if (!result.ok) {
      setFailure(result);
      return;
    }
    setEmail(parsed.data);
    setStep(result.data);
  }

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = createPasswordSchema.safeParse({ password, confirm });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    const result = await authApi.createPassword(email, parsed.data.password);
    setPending(false);
    // On success the auth store emits SIGNED_IN and useRedirectWhenSignedIn navigates.
    if (result.ok) return;
    if (result.code === "not_possible") setStep("not_possible");
    else if (result.code === "weak_password") setErrors({ password: PASSWORD_MIN_LENGTH_TEXT });
    else setFailure(result);
  }

  async function onSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFailure(null);
    const parsed = signInPasswordSchema.safeParse(password);
    if (!parsed.success) {
      setErrors({ password: parsed.error.issues[0]?.message ?? "Enter your password." });
      return;
    }
    setErrors({});
    setPending(true);
    const result = await authApi.signInWithPassword(email, parsed.data);
    setPending(false);
    if (!result.ok) setFailure(result);
  }

  if (step === "create_password") {
    return (
      <AuthCard title="Create your password">
        <EmailLine email={email} onChange={back} />
        <form onSubmit={onCreate} noValidate className="space-y-4">
          <TextField
            id="password"
            label="Password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={setPassword}
            error={errors.password}
          />
          <TextField
            id="confirm"
            label="Confirm password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={setConfirm}
            error={errors.confirm}
          />
          <p className="text-[13px] text-muted-foreground">{PASSWORD_MIN_LENGTH_TEXT}</p>
          <FailureText failure={failure} alertRef={alertRef} />
          <Button type="submit" className="min-h-11 w-full" disabled={pending}>
            Create password and sign in
          </Button>
        </form>
      </AuthCard>
    );
  }

  if (step === "sign_in") {
    return (
      <AuthCard title="Welcome back">
        <EmailLine email={email} onChange={back} />
        <form onSubmit={onSignIn} noValidate className="space-y-4">
          <TextField
            id="password"
            label="Password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={setPassword}
            error={errors.password}
          />
          <FailureText failure={failure} alertRef={alertRef} />
          <Button type="submit" className="min-h-11 w-full" disabled={pending}>
            Sign in
          </Button>
        </form>
        <p className="text-[13px] text-muted-foreground">
          Forgot it? Ask the person who invited you to reset it.
        </p>
      </AuthCard>
    );
  }

  if (step === "not_possible") {
    return (
      <AuthCard title="Not possible yet">
        <EmailLine email={email} onChange={back} />
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Sign in">
      <form onSubmit={onContinue} noValidate className="space-y-4">
        <TextField
          id="email"
          label="E-mail"
          type="email"
          autoComplete="email"
          value={email}
          onChange={setEmail}
          error={errors.email}
        />
        <FailureText failure={failure} alertRef={alertRef} />
        <Button type="submit" className="min-h-11 w-full" disabled={pending}>
          Continue
        </Button>
      </form>
    </AuthCard>
  );
}
