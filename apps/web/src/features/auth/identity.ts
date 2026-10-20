import type { User } from "@supabase/supabase-js";

type IdentityUser = Pick<User, "identities" | "app_metadata"> | null | undefined;

/**
 * Providers the account can sign in with. `identities` is authoritative (spec 11.4);
 * `app_metadata.providers` is the fallback when identities are not present on the user object.
 */
export function providersOf(user: IdentityUser): string[] {
  if (!user) return [];
  const found = new Set<string>();
  const identities = user.identities ?? [];
  if (identities.length > 0) {
    for (const identity of identities) {
      if (typeof identity.provider === "string") found.add(identity.provider.toLowerCase());
    }
  } else {
    const listed: unknown = user.app_metadata?.providers;
    if (Array.isArray(listed)) {
      for (const provider of listed) {
        if (typeof provider === "string") found.add(provider.toLowerCase());
      }
    }
  }
  return [...found].sort();
}

export function hasPasswordIdentity(user: IdentityUser): boolean {
  return providersOf(user).includes("email");
}

export function isGoogleOnly(user: IdentityUser): boolean {
  const providers = providersOf(user);
  return providers.length > 0 && providers.every((provider) => provider === "google");
}
