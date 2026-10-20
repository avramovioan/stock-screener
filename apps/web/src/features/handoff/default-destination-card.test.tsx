import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultDestinationCard } from "./default-destination-card";

const mocks = vi.hoisted(() => ({
  handoffApi: {
    getEurListings: vi.fn(),
    getDefaultDestination: vi.fn(),
    setDefaultDestination: vi.fn(),
  },
  auth: { useAuth: vi.fn() },
}));
vi.mock("@/features/handoff/default", () => ({ handoffApi: mocks.handoffApi }));
vi.mock("@/features/auth/auth-provider", () => mocks.auth);

const renderCard = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DefaultDestinationCard />
    </QueryClientProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.useAuth.mockReturnValue({ status: "signed-in", user: { id: "u1" }, recovery: false });
  mocks.handoffApi.getDefaultDestination.mockResolvedValue("IBIS2");
  mocks.handoffApi.setDefaultDestination.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe("DefaultDestinationCard (Profile > Broker)", () => {
  it("shows the stored default and offers the three destinations with their labels", async () => {
    mocks.handoffApi.getDefaultDestination.mockResolvedValue("AEB");
    renderCard();
    const select = (await screen.findByLabelText("Default destination")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("AEB"));
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["IBIS2", "IBIS", "AEB"]);
    expect(select.options[0]?.textContent).toContain(
      "owner practice, not in IBKR's public catalogue",
    );
    expect(mocks.handoffApi.getDefaultDestination).toHaveBeenCalledWith("u1");
  });

  it("saves a change to the signed-in user's own row and confirms it", async () => {
    renderCard();
    const select = (await screen.findByLabelText("Default destination")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "IBIS" } });
    await waitFor(() =>
      expect(mocks.handoffApi.setDefaultDestination).toHaveBeenCalledWith("u1", "IBIS"),
    );
    expect(await screen.findByText("Saved")).toBeTruthy();
    expect(select.value).toBe("IBIS");
  });

  it("says so when saving fails", async () => {
    mocks.handoffApi.setDefaultDestination.mockRejectedValue(new Error("nope"));
    renderCard();
    const select = (await screen.findByLabelText("Default destination")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    fireEvent.change(select, { target: { value: "AEB" } });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not save your default destination.",
    );
  });
});
