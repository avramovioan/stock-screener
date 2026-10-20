/** Builds a minimal TanStack Query result for mocked hooks. */
export function loaded<T>(data: T) {
  return { data, isLoading: false, isError: false, error: null, refetch: () => undefined } as never;
}
export function loading() {
  return {
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
    refetch: () => undefined,
  } as never;
}
export function failed(error: unknown, refetch: () => void = () => undefined) {
  return { data: undefined, isLoading: false, isError: true, error, refetch } as never;
}
