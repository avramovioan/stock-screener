import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

/** Shared by every reader of the own profile row so one write invalidates them all. */
export const profileQueryKey = (userId: string) => ["profile", userId] as const;

export interface Profile {
  userId: string;
  displayName: string | null;
}

const rowSchema = z.object({
  user_id: z.string(),
  display_name: z.string().nullable(),
});

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name.")
  .max(60, "Use at most 60 characters.")
  .refine((value) => !hasControlCharacter(value), "Use letters, digits and punctuation only.");

/** Own-row access through RLS and column grants (spec 6.8): only these two columns are read, only display_name is written. */
export function createProfileApi(client: Pick<SupabaseClient, "from">) {
  return {
    async getProfile(userId: string): Promise<Profile | null> {
      const { data, error } = await client
        .from("profiles")
        .select("user_id, display_name")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error("Could not load your profile.");
      if (data === null) return null;
      const row = rowSchema.parse(data);
      return { userId: row.user_id, displayName: row.display_name };
    },

    async updateDisplayName(userId: string, displayName: string): Promise<void> {
      const parsed = displayNameSchema.parse(displayName);
      const { error } = await client
        .from("profiles")
        .update({ display_name: parsed })
        .eq("user_id", userId);
      if (error) throw new Error("Could not save your name.");
    },
  };
}

export type ProfileApi = ReturnType<typeof createProfileApi>;
