export const words = (n: number): string =>
  Array.from({ length: n }, (_, i) => `word${i % 50}`).join(" ");
