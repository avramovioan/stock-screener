import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TextField } from "@/features/auth/components/text-field";
import { profileApi } from "../default";
import { displayNameSchema, profileQueryKey } from "../profile-api";

export function DisplayNameCard({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const profile = useQuery({
    queryKey: profileQueryKey(userId),
    queryFn: () => profileApi.getProfile(userId),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | undefined>();

  const save = useMutation({
    mutationFn: (name: string) => profileApi.updateDisplayName(userId, name),
    onSuccess: async () => {
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: profileQueryKey(userId) });
      toast.success("Your name was saved.");
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = displayNameSchema.safeParse(draft ?? profile.data?.displayName ?? "");
    if (!parsed.success) {
      setValidation(parsed.error.issues[0]?.message);
      return;
    }
    setValidation(undefined);
    save.mutate(parsed.data);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Display name</CardTitle>
        <CardDescription>Shown in the app. It is not used to sign in.</CardDescription>
      </CardHeader>
      <CardContent>
        {profile.isPending ? <Skeleton className="h-9 w-full max-w-md" /> : null}
        {profile.isError ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              Could not load your profile.
            </p>
            <Button type="button" variant="outline" onClick={() => profile.refetch()}>
              Retry
            </Button>
          </div>
        ) : null}
        {profile.isSuccess ? (
          <form onSubmit={onSubmit} noValidate className="max-w-md space-y-4">
            <TextField
              id="display-name"
              label="Display name"
              autoComplete="nickname"
              value={draft ?? profile.data?.displayName ?? ""}
              onChange={setDraft}
              error={validation}
            />
            {save.isError ? (
              <p role="alert" className="text-sm text-destructive">
                Could not save your name.
              </p>
            ) : null}
            {save.isSuccess ? <p role="status">Name saved.</p> : null}
            <Button type="submit" disabled={save.isPending}>
              Save name
            </Button>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
