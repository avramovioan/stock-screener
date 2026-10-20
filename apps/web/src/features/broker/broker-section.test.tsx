import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionResult, BrokerConnection, BrokerRun, BrokerSnapshot } from "./broker-api";
import { BrokerSection } from "./broker-section";

const api = { readSnapshot: vi.fn(), link: vi.fn(), test: vi.fn(), sync: vi.fn(), unlink: vi.fn() };
vi.mock("./default", () => ({
  brokerApi: {
    readSnapshot: (...a: unknown[]) => api.readSnapshot(...a),
    link: (...a: unknown[]) => api.link(...a),
    test: (...a: unknown[]) => api.test(...a),
    sync: (...a: unknown[]) => api.sync(...a),
    unlink: (...a: unknown[]) => api.unlink(...a),
  },
}));

const TOKEN = "987654321012345678901234";
const linked: BrokerConnection = {
  id: "c",
  status: "linked",
  token_expires_on: "2027-06-01",
  query_id: "123456",
  account_id_masked: "U***4567",
  base_currency: "EUR",
  account_type: "Individual",
  linked_at: "2026-10-01T00:00:00Z",
  last_verified_at: "2026-10-15T05:00:00Z",
  last_sync_at: "2026-10-15T05:01:00Z",
  last_statement_date: "2026-10-14",
  last_error_code: null,
  last_error_at: null,
  last_error_message: null,
  coverage_from: "2025-10-15",
};
const doneRun: BrokerRun = {
  id: "r",
  kind: "daily",
  state: "done",
  error_code: null,
  error_message: null,
  rows_summary: {},
};
const snap = (
  connection: BrokerConnection | null,
  run: BrokerRun | null = null,
): BrokerSnapshot => ({ connection, run });

let lastClient: QueryClient;
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastClient = client;
  return render(
    <QueryClientProvider client={client}>
      <BrokerSection />
    </QueryClientProvider>,
  );
}
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
function submitLink() {
  fill("Flex token", TOKEN);
  fill("Query ID", "123456");
  fill("Token expiry date", "2027-06-01");
  const form = screen.getByRole("button", { name: /^Link/ }).closest("form");
  if (form === null) throw new Error("no form");
  fireEvent.submit(form);
}

beforeEach(() => {
  for (const f of Object.values(api)) f.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-15T08:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("BrokerSection", () => {
  it("shows the supported method, requirements, setup guide and the link form when nothing is linked", async () => {
    api.readSnapshot.mockResolvedValue(snap(null));
    mount();
    expect(await screen.findByText("IBKR Flex Web Service, read-only")).toBeTruthy();
    expect(await screen.findByText("Not linked")).toBeTruthy();
    expect(screen.getByLabelText("Flex token")).toBeTruthy();
    expect(screen.getByText("How to set up IBKR Flex")).toBeTruthy();
    expect(screen.getByText("What this cannot do")).toBeTruthy();
    expect(screen.getByText(/recorded in the audit log/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sync now" })).toBeNull();
  });

  it("link: sends the values once, clears the token, refreshes the status to Linked", async () => {
    api.readSnapshot.mockResolvedValueOnce(snap(null)).mockResolvedValue(snap(linked, doneRun));
    api.link.mockResolvedValue({
      ok: true,
      connection: linked,
      run: doneRun,
    } satisfies ActionResult);
    mount();
    await screen.findByText("Not linked");
    submitLink();
    await waitFor(() =>
      expect(api.link).toHaveBeenCalledWith({
        token: TOKEN,
        queryId: "123456",
        tokenExpiresOn: "2027-06-01",
      }),
    );
    expect(await screen.findByText("Linked")).toBeTruthy();
    expect(api.link).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("link rejected by IBKR (1015): the status turns to error with the token hint, the token is gone from the form", async () => {
    const bad: BrokerConnection = {
      ...linked,
      status: "error",
      last_error_code: 1015,
      last_error_at: "2026-10-15T08:00:10Z",
    };
    api.readSnapshot
      .mockResolvedValueOnce(snap(null))
      .mockResolvedValue(
        snap(bad, { ...doneRun, kind: "verify", state: "failed", error_code: 1015 }),
      );
    api.link.mockResolvedValue({
      ok: true,
      connection: bad,
      run: { ...doneRun, state: "failed", error_code: 1015 },
    } satisfies ActionResult);
    mount();
    await screen.findByText("Not linked");
    submitLink();
    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(screen.getByText(/Copy the Current Token again/)).toBeTruthy();
    expect((screen.getByLabelText("Flex token") as HTMLInputElement).value).toBe("");
  });

  it("a server-side field error is shown at the field", async () => {
    api.readSnapshot.mockResolvedValue(snap(null));
    api.link.mockResolvedValue({
      ok: false,
      kind: "invalid_input",
      field: "tokenExpiresOn",
      message: "IBKR tokens last at most one year.",
    } satisfies ActionResult);
    mount();
    await screen.findByText("Not linked");
    submitLink();
    expect(await screen.findByText("IBKR tokens last at most one year.")).toBeTruthy();
  });

  it("linked: status details, Test connection, Sync now and the cooldown message", async () => {
    api.readSnapshot.mockResolvedValue(snap(linked, doneRun));
    api.test.mockResolvedValue({
      ok: true,
      connection: linked,
      run: doneRun,
    } satisfies ActionResult);
    api.sync.mockResolvedValue({
      ok: false,
      kind: "cooldown",
      retryAfterSeconds: 421,
    } satisfies ActionResult);
    mount();
    expect(await screen.findByText("U***4567")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(api.test).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText(/Manual sync is limited to once every 10 minutes/)).toBeTruthy();
    expect(screen.getByText(/Try again in 8 minutes/)).toBeTruthy();
  });

  it("while a sync runs the buttons are disabled and the step is shown", async () => {
    api.readSnapshot.mockResolvedValue(snap(linked, { ...doneRun, state: "polling" }));
    mount();
    expect(await screen.findByText("Waiting for IBKR to generate the statement")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sync now" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("unlink asks for confirmation, then unlinks with the delete choice", async () => {
    api.readSnapshot
      .mockResolvedValueOnce(snap(linked, doneRun))
      .mockResolvedValue(snap({ ...linked, status: "unlinked" }));
    api.unlink.mockResolvedValue({
      ok: true,
      connection: { ...linked, status: "unlinked" },
      run: null,
    } satisfies ActionResult);
    mount();
    await screen.findByText("Linked");
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("Also delete my synced broker data"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(api.unlink).toHaveBeenCalledWith({ deleteData: true }));
    expect(await screen.findByText("Not linked")).toBeTruthy();
  });

  it("a failed status read shows an error with Retry, never a blank", async () => {
    api.readSnapshot
      .mockRejectedValueOnce(new Error("Could not load the broker connection."))
      .mockResolvedValue(snap(null));
    mount();
    expect(await screen.findByText("Could not load the broker connection.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Not linked")).toBeTruthy();
  });

  it("the Flex token never ends up in the mutation cache after a link", async () => {
    api.readSnapshot.mockResolvedValueOnce(snap(null)).mockResolvedValue(snap(linked, doneRun));
    api.link.mockResolvedValue({
      ok: true,
      connection: linked,
      run: doneRun,
    } satisfies ActionResult);
    mount();
    await screen.findByText("Not linked");
    submitLink();
    await waitFor(() => expect(api.link).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Linked")).toBeTruthy();
    await waitFor(() => expect(lastClient.getMutationCache().getAll()).toHaveLength(0));
    const dump = JSON.stringify(
      lastClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
    );
    expect(dump).not.toContain(TOKEN);
  });

  it("a mutation that is still pending holds no token in its variables", async () => {
    api.readSnapshot.mockResolvedValue(snap(null));
    let finish: (r: ActionResult) => void = () => undefined;
    api.link.mockReturnValue(new Promise<ActionResult>((r) => (finish = r)));
    mount();
    await screen.findByText("Not linked");
    submitLink();
    await waitFor(() => expect(api.link).toHaveBeenCalledTimes(1));
    const states = lastClient
      .getMutationCache()
      .getAll()
      .map((m) => m.state);
    expect(states.length).toBeGreaterThan(0);
    expect(JSON.stringify(states)).not.toContain(TOKEN);
    finish({ ok: true, connection: linked, run: doneRun });
  });

  it("starting another action clears the previous notice", async () => {
    api.readSnapshot.mockResolvedValue(snap(linked, doneRun));
    api.sync.mockResolvedValue({ ok: false, kind: "busy" } satisfies ActionResult);
    api.test.mockResolvedValue({
      ok: true,
      connection: linked,
      run: doneRun,
    } satisfies ActionResult);
    mount();
    await screen.findByText("U***4567");
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    expect(await screen.findByText(/A sync is already running/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(screen.queryByText(/A sync is already running/)).toBeNull());
  });

  it("the Link button is disabled while a sync run is active", async () => {
    api.readSnapshot.mockResolvedValue(snap(linked, { ...doneRun, state: "polling" }));
    mount();
    await screen.findByText("Waiting for IBKR to generate the statement");
    expect((screen.getByRole("button", { name: /^Link/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
