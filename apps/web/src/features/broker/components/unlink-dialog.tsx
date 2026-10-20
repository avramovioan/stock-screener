import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function UnlinkDialog({
  open,
  onOpenChange,
  onConfirm,
  pending,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onConfirm(o: { deleteData: boolean }): void;
  pending: boolean;
}) {
  const [deleteData, setDeleteData] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlink your IBKR account?</DialogTitle>
          <DialogDescription>
            The app deletes the stored token and the Query ID and stops syncing. Your positions,
            trades and analytics stay unless you tick the box below.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          Please revoke the token in IBKR (Client Portal, Flex Web Service Configuration: disable
          the service or generate a new token): the app cannot revoke it, because IBKR documents no
          revocation API.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={deleteData}
            onChange={(e) => setDeleteData(e.target.checked)}
          />
          Also delete my synced broker data
        </label>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => onConfirm({ deleteData })}
          >
            {pending ? "Unlinking..." : "Unlink"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
