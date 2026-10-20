/** Focus and navigate an open window, otherwise (or if either step rejects) open a new one. */
export async function focusOrOpen(clients: Clients, target: string): Promise<void> {
  const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
  const existing = windows[0];
  if (existing) {
    try {
      await existing.focus();
      await existing.navigate(target);
      return;
    } catch {
      // navigate() rejects for clients this worker does not control: fall back to a new window
    }
  }
  await clients.openWindow(target);
}
