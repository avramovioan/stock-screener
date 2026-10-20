import { vi } from "vitest";
import type { ProfileApi } from "@/features/profile/profile-api";

export const profileApiMock = {
  getProfile: vi.fn(),
  updateDisplayName: vi.fn(),
} satisfies Record<keyof ProfileApi, unknown>;

export const profileDefaultMock = { profileApi: profileApiMock };
