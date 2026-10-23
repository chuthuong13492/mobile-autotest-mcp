/** Wall-clock budget for inspection (TL-02/TL-03: 60 s). Work that does not finish in time is abandoned and reported. */

export const DEFAULT_BUDGET_MS = 60_000;

export type Timed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: 'timeout' | 'error' };

export interface Budget {
  remaining(): number;
  run<T>(work: () => Promise<T>): Promise<Timed<T>>;
}

export function createBudget(ms: number, now: () => number = Date.now): Budget {
  const deadline = now() + ms;
  const remaining = () => Math.max(0, deadline - now());
  return {
    remaining,
    async run<T>(work: () => Promise<T>): Promise<Timed<T>> {
      const left = remaining();
      if (left <= 0) return { ok: false, reason: 'timeout' };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<Timed<T>>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), left);
      });
      try {
        return await Promise.race([
          work().then(
            (value): Timed<T> => ({ ok: true, value }),
            (): Timed<T> => ({ ok: false, reason: 'error' }),
          ),
          timeout,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
