import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PullToRefresh } from "./pull-to-refresh";

// happy-dom exposes scrollY as a getter only
const setScroll = (y: number) =>
  Object.defineProperty(window, "scrollY", { configurable: true, value: y });

const touch = (y: number) => ({ touches: [{ clientY: y }], changedTouches: [{ clientY: y }] });

function setup(props: { disabled?: boolean } = {}) {
  const onRefresh = vi.fn();
  render(
    <PullToRefresh onRefresh={onRefresh} {...props}>
      <p>content</p>
    </PullToRefresh>,
  );
  return { onRefresh, area: screen.getAllByTestId("pull-area").at(-1) as HTMLElement };
}

describe("PullToRefresh", () => {
  it("a downward pull of at least 70 px from the top triggers a refresh on release", () => {
    setScroll(0);
    const { onRefresh, area } = setup();
    fireEvent.touchStart(area, touch(100));
    fireEvent.touchMove(area, touch(190));
    expect(screen.getByText("Release to refresh")).toBeTruthy();
    fireEvent.touchEnd(area, touch(190));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("a short pull, an upward swipe, a pull that starts below the top or a disabled control do nothing", () => {
    setScroll(0);
    const a = setup();
    fireEvent.touchStart(a.area, touch(100));
    fireEvent.touchMove(a.area, touch(140));
    fireEvent.touchEnd(a.area, touch(140));
    fireEvent.touchStart(a.area, touch(300));
    fireEvent.touchMove(a.area, touch(100));
    fireEvent.touchEnd(a.area, touch(100));
    expect(a.onRefresh).not.toHaveBeenCalled();

    setScroll(200);
    const b = setup();
    fireEvent.touchStart(b.area, touch(100));
    fireEvent.touchEnd(b.area, touch(260));
    expect(b.onRefresh).not.toHaveBeenCalled();

    setScroll(0);
    const c = setup({ disabled: true });
    fireEvent.touchStart(c.area, touch(100));
    fireEvent.touchEnd(c.area, touch(260));
    expect(c.onRefresh).not.toHaveBeenCalled();
  });
});
