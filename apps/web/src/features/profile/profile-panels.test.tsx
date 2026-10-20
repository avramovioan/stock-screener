import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { signedIn } from "@/test/auth-fixtures";
import { handoffApiMock } from "@/test/handoff-default-mock";
import { renderApp } from "@/test/render-app";

// The panel builds its API lazily from the real Supabase client; replace it so no request is made.
vi.mock("@/lib/supabase", () => ({ supabase: {} }));
vi.mock("@/features/broker/default", () => ({
  brokerApi: {
    readSnapshot: () => Promise.resolve({ connection: null, run: null }),
    link: vi.fn(),
    test: vi.fn(),
    sync: vi.fn(),
    unlink: vi.fn(),
  },
}));
describe("Broker shell", () => {
  it("renders the Broker heading and the broker section", async () => {
    handoffApiMock.getDefaultDestination.mockResolvedValue("IBIS2");
    await renderApp("/profile/broker", signedIn());
    expect(await screen.findByRole("heading", { level: 1, name: "Broker" })).toBeTruthy();
    expect(await screen.findByText("IBKR Flex Web Service, read-only")).toBeTruthy();
    expect(await screen.findByLabelText("Default destination")).toBeTruthy();
  });
});
