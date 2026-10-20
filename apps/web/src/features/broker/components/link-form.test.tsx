import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkForm } from "./link-form";

const TOKEN = "987654321012345678901234";

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function submit() {
  const form = screen.getByRole("button", { name: /^Link/ }).closest("form");
  if (form === null) throw new Error("no form");
  fireEvent.submit(form);
}
function fillAll() {
  fill("Flex token", TOKEN);
  fill("Query ID", "123456");
  fill("Token expiry date", "2027-06-01");
}

afterEach(() => vi.restoreAllMocks());

describe("LinkForm", () => {
  it("the token field is a password field, autocomplete off, and never prefilled", () => {
    render(
      <LinkForm
        pending={false}
        onSubmit={vi.fn()}
        fieldError={null}
        now={new Date("2026-10-15T08:00:00Z")}
      />,
    );
    const token = screen.getByLabelText("Flex token") as HTMLInputElement;
    expect([token.type, token.autocomplete, token.value]).toEqual(["password", "off", ""]);
  });

  it("submits the three values and clears the token right after the submit", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    render(
      <LinkForm
        pending={false}
        onSubmit={onSubmit}
        fieldError={null}
        now={new Date("2026-10-15T08:00:00Z")}
      />,
    );
    fillAll();
    submit();
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        token: TOKEN,
        queryId: "123456",
        tokenExpiresOn: "2027-06-01",
      }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Flex token") as HTMLInputElement).value).toBe(""),
    );
  });

  it("never writes the token to localStorage, sessionStorage or the document", async () => {
    const local = vi.spyOn(Storage.prototype, "setItem");
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    render(
      <LinkForm
        pending={false}
        onSubmit={onSubmit}
        fieldError={null}
        now={new Date("2026-10-15T08:00:00Z")}
      />,
    );
    fillAll();
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(local).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("client-side checks name the field and do not call the server", () => {
    const onSubmit = vi.fn();
    render(
      <LinkForm
        pending={false}
        onSubmit={onSubmit}
        fieldError={null}
        now={new Date("2026-10-15T08:00:00Z")}
      />,
    );
    fill("Flex token", "short");
    fill("Query ID", "abc");
    fill("Token expiry date", "2026-10-01");
    submit();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Enter the token exactly as shown by IBKR.")).toBeTruthy();
    expect(screen.getByText("The Query ID is a number of 3 to 12 digits.")).toBeTruthy();
    expect(screen.getByText("The token expiry date must be in the future.")).toBeTruthy();
  });

  it("a server field error is shown next to the field and the typed values are kept for that field error", async () => {
    const onSubmit = vi.fn().mockResolvedValue({
      ok: false,
      kind: "invalid_input",
      field: "queryId",
      message: "The Query ID is a number of 3 to 12 digits.",
    });
    const { rerender } = render(
      <LinkForm
        pending={false}
        onSubmit={onSubmit}
        fieldError={null}
        now={new Date("2026-10-15T08:00:00Z")}
      />,
    );
    fillAll();
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    rerender(
      <LinkForm
        pending={false}
        onSubmit={onSubmit}
        fieldError={{ field: "queryId", message: "The Query ID is a number of 3 to 12 digits." }}
        now={new Date("2026-10-15T08:00:00Z")}
      />,
    );
    expect(screen.getByText("The Query ID is a number of 3 to 12 digits.")).toBeTruthy();
    expect((screen.getByLabelText("Query ID") as HTMLInputElement).value).toBe("123456");
  });

  it("while pending the button says so and cannot be pressed twice", () => {
    render(
      <LinkForm
        pending
        onSubmit={vi.fn()}
        fieldError={null}
        now={new Date("2026-10-15T08:00:00Z")}
      />,
    );
    const button = screen.getByRole("button", { name: /Linking/ }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/this can take up to a minute/)).toBeTruthy();
  });
});
