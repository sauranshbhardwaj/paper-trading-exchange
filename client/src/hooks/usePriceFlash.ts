import { useState } from 'react';

export type FlashDirection = 'up' | 'down' | null;

/**
 * Which way a price just moved. Uses React's "adjust state while rendering"
 * pattern instead of an effect, so there's no extra render with a stale value.
 */
export function usePriceFlash(value: bigint | null): FlashDirection {
  const [previous, setPrevious] = useState(value);
  const [direction, setDirection] = useState<FlashDirection>(null);
  if (value !== previous) {
    setPrevious(value);
    setDirection(value !== null && previous !== null ? (value > previous ? 'up' : 'down') : null);
  }
  return direction;
}
