import { describe, expect, it, vi } from "vitest";
import { createProfileApi, displayNameSchema } from "./profile-api";

function makeClient(result: { data: unknown; error: { message: string } | null }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eqSelect = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq: eqSelect });
  const eqUpdate = vi.fn().mockResolvedValue({ error: result.error });
  const update = vi.fn().mockReturnValue({ eq: eqUpdate });
  const from = vi.fn().mockReturnValue({ select, update });
  return {
    from,
    select,
    eqSelect,
    update,
    eqUpdate,
    client: { from } as unknown as Parameters<typeof createProfileApi>[0],
  };
}

describe("getProfile", () => {
  it("selects only the two columns for the user", async () => {
    const m = makeClient({
      data: { user_id: "u1", display_name: "Alice" },
      error: null,
    });
    expect(await createProfileApi(m.client).getProfile("u1")).toEqual({
      userId: "u1",
      displayName: "Alice",
    });
    expect(m.from).toHaveBeenCalledWith("profiles");
    expect(m.select).toHaveBeenCalledWith("user_id, display_name");
    expect(m.eqSelect).toHaveBeenCalledWith("user_id", "u1");
  });

  it("returns null when there is no row and throws a fixed message on error", async () => {
    expect(
      await createProfileApi(makeClient({ data: null, error: null }).client).getProfile("u1"),
    ).toBeNull();
    await expect(
      createProfileApi(
        makeClient({ data: null, error: { message: "secret db detail" } }).client,
      ).getProfile("u1"),
    ).rejects.toThrow("Could not load your profile.");
  });
});

describe("updateDisplayName", () => {
  it("writes the trimmed name for the user only", async () => {
    const m = makeClient({ data: null, error: null });
    await createProfileApi(m.client).updateDisplayName("u1", "  Alice B  ");
    expect(m.update).toHaveBeenCalledWith({ display_name: "Alice B" });
    expect(m.eqUpdate).toHaveBeenCalledWith("user_id", "u1");
  });

  it("rejects an invalid name before any request and maps a database error", async () => {
    const m = makeClient({ data: null, error: { message: "secret db detail" } });
    const api = createProfileApi(m.client);
    await expect(api.updateDisplayName("u1", "   ")).rejects.toThrow();
    expect(m.update).not.toHaveBeenCalled();
    await expect(api.updateDisplayName("u1", "Alice")).rejects.toThrow("Could not save your name.");
  });
});

describe("displayNameSchema", () => {
  it.each([["Alice"], ["A"], ["x".repeat(60)]])("accepts %s", (value) => {
    expect(displayNameSchema.safeParse(value).success).toBe(true);
  });
  it.each([[""], ["   "], ["x".repeat(61)], ["bad\u0000name"], ["tab\tname"]])(
    "rejects %j",
    (value) => {
      expect(displayNameSchema.safeParse(value).success).toBe(false);
    },
  );
});
