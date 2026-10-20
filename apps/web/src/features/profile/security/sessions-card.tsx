import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useSignOut } from "@/features/auth/use-sign-out";

export function SessionsCard() {
  const signOut = useSignOut();
  const [confirming, setConfirming] = useState(false);

  async function onConfirm() {
    const failure = await signOut("global");
    if (failure) toast.error(failure.message);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
        <CardDescription>
          Signs you out on every device where you are signed in, including this one. The action is
          recorded.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {confirming ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="destructive" onClick={onConfirm}>
              Yes, sign out everywhere
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
            Sign out of all devices
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
