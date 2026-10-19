// A time limit for work that can otherwise wait forever, such as pathfinding and digging.
export interface Within {
  <T>(ms: number, label: string, work: Promise<T>, cancel: () => void): Promise<T>;
}

/** Rejects after `ms` and runs `cancel`; pathfinding and digging can otherwise wait forever. */
export const within: Within = <T>(ms: number, label: string, work: Promise<T>, cancel: () => void): Promise<T> => {
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    cancel();
    expired.reject(new Error(`${label} took longer than ${ms} ms`));
  }, ms);
  return Promise.race([work, expired.promise]).finally(() => clearTimeout(timer));
};
