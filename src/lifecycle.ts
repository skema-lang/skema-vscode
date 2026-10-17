/** Runs each step only after the previous one settled; a failed step still lets the next one run. */
export function oneAtATime(): (step: () => Promise<void>) => Promise<void> {
  let previous: Promise<void> = Promise.resolve();
  return (step) => {
    const current = previous.then(step);
    previous = current.catch(() => undefined);
    return current;
  };
}
