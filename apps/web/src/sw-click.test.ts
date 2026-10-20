import { describe, expect, it, vi } from "vitest";
import { focusOrOpen } from "./sw-click.ts";

function fakeClients(windows: unknown[]) {
  return {
    matchAll: vi.fn().mockResolvedValue(windows),
    openWindow: vi.fn().mockResolvedValue(null),
  } as unknown as Clients & { openWindow: ReturnType<typeof vi.fn> };
}

describe("focusOrOpen", () => {
  it("focuses and navigates an existing window", async () => {
    const win = {
      focus: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockResolvedValue(null),
    };
    const clients = fakeClients([win]);
    await focusOrOpen(clients, "/a");
    expect(win.navigate).toHaveBeenCalledWith("/a");
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it("falls back to openWindow when navigate rejects", async () => {
    const win = {
      focus: vi.fn().mockResolvedValue(undefined),
      navigate: vi.fn().mockRejectedValue(new TypeError("uncontrolled client")),
    };
    const clients = fakeClients([win]);
    await focusOrOpen(clients, "/a");
    expect(clients.openWindow).toHaveBeenCalledWith("/a");
  });

  it("falls back to openWindow when focus rejects", async () => {
    const win = { focus: vi.fn().mockRejectedValue(new Error("no")), navigate: vi.fn() };
    const clients = fakeClients([win]);
    await focusOrOpen(clients, "/a");
    expect(clients.openWindow).toHaveBeenCalledWith("/a");
  });

  it("opens a window when none exists", async () => {
    const clients = fakeClients([]);
    await focusOrOpen(clients, "/a");
    expect(clients.openWindow).toHaveBeenCalledWith("/a");
  });
});
