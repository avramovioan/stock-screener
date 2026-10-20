import { vi } from "vitest";
import type { HandoffApi } from "@/features/handoff/handoff-api";

export const handoffApiMock = {
  getEurListings: vi.fn(),
  getCatalogueListings: vi.fn(),
  getDefaultDestination: vi.fn(),
  setDefaultDestination: vi.fn(),
} satisfies Record<keyof HandoffApi, unknown>;

export const handoffDefaultMock = { handoffApi: handoffApiMock };
