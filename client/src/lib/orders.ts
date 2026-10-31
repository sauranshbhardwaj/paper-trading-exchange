/** Pure helpers for keeping the user's order lists in sync with REST + WebSocket updates. */
import type { OrderDto } from '@pte/shared';

export const MAX_HISTORY = 50;

export interface OrdersState {
  open: OrderDto[];
  history: OrderDto[];
}

export const EMPTY_ORDERS: OrdersState = { open: [], history: [] };

function newestFirst(a: OrderDto, b: OrderDto): number {
  const difference = BigInt(b.id) - BigInt(a.id);
  return difference === 0n ? 0 : difference > 0n ? 1 : -1;
}

/**
 * Insert or replace one order. An update older than what we already have is
 * ignored, so a slow REST response can't overwrite a newer WebSocket update.
 */
export function applyOrderUpdate(state: OrdersState, order: OrderDto): OrdersState {
  const existing = [...state.open, ...state.history].find((o) => o.id === order.id);
  if (existing && existing.updatedAt > order.updatedAt) return state;

  const open = state.open.filter((o) => o.id !== order.id);
  const history = state.history.filter((o) => o.id !== order.id);
  if (order.status === 'open') {
    return { open: [...open, order].sort(newestFirst), history };
  }
  return { open, history: [...history, order].sort(newestFirst).slice(0, MAX_HISTORY) };
}

export function mergeOrders(state: OrdersState, orders: OrderDto[]): OrdersState {
  return orders.reduce(applyOrderUpdate, state);
}
