import type { AuthChangeEvent, Session } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { makeSession, passwordUser } from "@/test/auth-fixtures";
import { createAuthStore } from "./auth-store";

function makeFakeClient(initial: Session | null, emitInitial = true) {
  let listener: ((event: AuthChangeEvent, session: Session | null) => void) | undefined;
  const unsubscribe = vi.fn();
  const client = {
    auth: {
      onAuthStateChange: vi.fn(
        (callback: (event: AuthChangeEvent, session: Session | null) => void) => {
          listener = callback;
          if (emitInitial) queueMicrotask(() => callback("INITIAL_SESSION", initial));
          return { data: { subscription: { unsubscribe } } };
        },
      ),
      getSession: vi.fn(async () => ({ data: { session: initial }, error: null })),
    },
  } as unknown as Parameters<typeof createAuthStore>[0];
  return {
    client,
    unsubscribe,
    emit: (event: AuthChangeEvent, session: Session | null) => listener?.(event, session),
  };
}

const session = makeSession(passwordUser);

describe("createAuthStore", () => {
  it("starts in loading and resolves to signed-in", async () => {
    const { client } = makeFakeClient(session);
    const store = createAuthStore(client);
    expect(store.getState().status).toBe("loading");
    await vi.waitFor(() => expect(store.getState().status).toBe("signed-in"));
    expect(store.getState().user?.id).toBe("user-1");
    expect(store.getState().recovery).toBe(false);
  });

  it("resolves to signed-out without a session and does not report a sign-out", async () => {
    const onSignedOut = vi.fn();
    const { client } = makeFakeClient(null);
    const store = createAuthStore(client, { onSignedOut });
    await vi.waitFor(() => expect(store.getState().status).toBe("signed-out"));
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("falls back to getSession when INITIAL_SESSION is never emitted", async () => {
    const { client } = makeFakeClient(session, false);
    const store = createAuthStore(client);
    await vi.waitFor(() => expect(store.getState().status).toBe("signed-in"));
  });

  it("holds the recovery flag in memory only and keeps it across token refreshes", async () => {
    const { client, emit } = makeFakeClient(null);
    const store = createAuthStore(client);
    await vi.waitFor(() => expect(store.getState().status).toBe("signed-out"));
    emit("PASSWORD_RECOVERY", session);
    expect(store.getState()).toMatchObject({ status: "signed-in", recovery: true });
    emit("TOKEN_REFRESHED", session);
    expect(store.getState().recovery).toBe(true);
    store.clearRecovery();
    expect(store.getState()).toMatchObject({ status: "signed-in", recovery: false });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("clears recovery and notifies on SIGNED_OUT", async () => {
    const onSignedOut = vi.fn();
    const { client, emit } = makeFakeClient(session);
    const store = createAuthStore(client, { onSignedOut });
    await vi.waitFor(() => expect(store.getState().status).toBe("signed-in"));
    emit("PASSWORD_RECOVERY", session);
    emit("SIGNED_OUT", null);
    expect(store.getState()).toMatchObject({
      status: "signed-out",
      user: null,
      session: null,
      recovery: false,
    });
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it("notifies subscribers, supports unsubscribe, and dispose detaches from supabase", async () => {
    const { client, emit, unsubscribe } = makeFakeClient(null);
    const store = createAuthStore(client);
    const listener = vi.fn();
    const stop = store.subscribe(listener);
    await vi.waitFor(() => expect(store.getState().status).toBe("signed-out"));
    const callsAfterInit = listener.mock.calls.length;
    emit("SIGNED_IN", session);
    expect(listener.mock.calls.length).toBe(callsAfterInit + 1);
    stop();
    emit("SIGNED_OUT", null);
    expect(listener.mock.calls.length).toBe(callsAfterInit + 1);
    store.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
