/** Fixture logic for the Jest tests. */
export const add = (a: number, b: number): number => a + b;

export const divide = (a: number, b: number): number | null => (b === 0 ? null : a / b);
