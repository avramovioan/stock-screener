import { z } from "zod";

/** The length rule of the `account-access` function (12 to 72 characters). */
export const PASSWORD_MIN_LENGTH_TEXT = "At least 12 characters.";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email("Enter a valid email address."));

/** The one password rule (invite flow and Profile): 12 to 72 characters, any characters. */
export const passwordSchema = z
  .string()
  .min(12, PASSWORD_MIN_LENGTH_TEXT)
  .max(72, "At most 72 characters.");

/** Sign-in applies no policy: it only needs something to send. */
export const signInPasswordSchema = z.string().min(1, "Enter your password.");

/** First sign-in of an invited e-mail: 12 to 72 characters and a matching confirmation. */
export const createPasswordSchema = z
  .object({
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((value) => value.password === value.confirm, {
    path: ["confirm"],
    message: "The passwords do not match.",
  });

export const changePasswordSchema = z
  .object({
    current: z.string().min(1, "Enter your current password."),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((value) => value.password === value.confirm, {
    path: ["confirm"],
    message: "The passwords do not match.",
  });

/** First message per field (`form` for issues without a path). */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
