import { useEffect, useRef } from "react";

/**
 * After a failed submit, moves focus to the first invalid field (client validation) or to the
 * error message (server failure). Returns the ref for the error element (role="alert").
 * `fieldOrder` lists the field ids in visual order.
 */
export function useFocusOnError(
  errors: Record<string, string>,
  failure: unknown,
  fieldOrder: readonly string[],
  fieldIds: Record<string, string> = {},
) {
  const alertRef = useRef<HTMLParagraphElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new errors/failure object is the trigger
  useEffect(() => {
    const key = fieldOrder.find((name) => errors[name] !== undefined);
    if (key !== undefined) document.getElementById(fieldIds[key] ?? key)?.focus();
  }, [errors]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new failure object is the trigger
  useEffect(() => {
    if (failure) alertRef.current?.focus();
  }, [failure]);
  return alertRef;
}
