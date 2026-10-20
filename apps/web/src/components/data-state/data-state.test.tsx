import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmptyState, ErrorState, Loading, Skeleton } from "./data-state";

afterEach(cleanup);

describe("DataState", () => {
  it("Loading is a polite busy status with screen-reader text", () => {
    render(<Loading label="Loading discounts" />);
    const el = screen.getByRole("status");
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(el.textContent).toContain("Loading discounts");
  });
  it("Skeleton is hidden from assistive technology", () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
  });
  it("ErrorState shows the message and Retry calls back", () => {
    const retry = vi.fn();
    render(<ErrorState message="Check your connection and try again." onRetry={retry} />);
    expect(screen.getByRole("alert").textContent).toContain("Check your connection");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it("ErrorState without onRetry has no button", () => {
    render(<ErrorState message="boom" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("EmptyState explains why it is empty", () => {
    render(<EmptyState title="No discounts today" description="2 candidates are withheld." />);
    expect(screen.getByText("No discounts today")).toBeTruthy();
    expect(screen.getByText("2 candidates are withheld.")).toBeTruthy();
  });
  it("the Retry button has a visible focus style", () => {
    render(<ErrorState message="boom" onRetry={() => undefined} />);
    expect(screen.getByRole("button", { name: "Retry" }).className).toContain(
      "focus-visible:outline-2",
    );
  });
});
