import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnlinkDialog } from "./unlink-dialog";

describe("UnlinkDialog", () => {
  it("explains what happens, tells the user to revoke the token at IBKR and keeps data deletion off by default", () => {
    render(<UnlinkDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} pending={false} />);
    expect(screen.getByText(/revoke the token in IBKR/i)).toBeTruthy();
    expect(screen.getByText(/the app cannot revoke it/i)).toBeTruthy();
    const box = screen.getByLabelText("Also delete my synced broker data") as HTMLInputElement;
    expect(box.checked).toBe(false);
  });

  it("confirm passes the checkbox value; cancel does nothing", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(<UnlinkDialog open onOpenChange={onOpenChange} onConfirm={onConfirm} pending={false} />);
    fireEvent.click(screen.getByLabelText("Also delete my synced broker data"));
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(onConfirm).toHaveBeenCalledWith({ deleteData: true });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("is not rendered when closed and cannot be confirmed twice while pending", () => {
    const { rerender } = render(
      <UnlinkDialog open={false} onOpenChange={vi.fn()} onConfirm={vi.fn()} pending={false} />,
    );
    expect(screen.queryByText(/revoke the token/i)).toBeNull();
    rerender(<UnlinkDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} pending />);
    expect((screen.getByRole("button", { name: /Unlinking/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
