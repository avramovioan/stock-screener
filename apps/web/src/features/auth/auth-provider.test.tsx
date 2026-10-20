import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createFakeAuthStore, googleUser, signedIn, signedOut } from "@/test/auth-fixtures";
import { AuthProvider, useAuth } from "./auth-provider";

function Probe() {
  const { status, user, recovery } = useAuth();
  return (
    <p data-testid="probe">
      {status}|{user?.id ?? "none"}|{recovery ? "recovery" : "normal"}
    </p>
  );
}

describe("AuthProvider", () => {
  it("exposes status, user and the recovery flag and follows store updates", () => {
    const store = createFakeAuthStore();
    render(
      <AuthProvider store={store}>
        <Probe />
      </AuthProvider>,
    );
    expect(screen.getByTestId("probe").textContent).toBe("loading|none|normal");
    act(() => store.set(signedIn(googleUser, { recovery: true })));
    expect(screen.getByTestId("probe").textContent).toBe("signed-in|user-1|recovery");
    act(() => store.set(signedOut));
    expect(screen.getByTestId("probe").textContent).toBe("signed-out|none|normal");
  });

  it("throws when used outside the provider", () => {
    expect(() => render(<Probe />)).toThrow(/AuthProvider/);
  });
});
