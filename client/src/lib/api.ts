/**
 * Typed wrapper around fetch. Every failure becomes an ApiError with a
 * message that is safe to show the user — network errors included.
 */
import type {
  ApiErrorBody,
  BalanceDto,
  LoginInput,
  OrderDto,
  PlaceOrderInput,
  RegisterInput,
  UserDto,
} from '@pte/shared';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: Record<string, string>;

  constructor(status: number, code: string, message: string, fields: Record<string, string> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorBody).error?.message === 'string'
  );
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection.');
  }

  const data: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    if (isApiErrorBody(data)) {
      throw new ApiError(response.status, data.error.code, data.error.message, data.error.fields);
    }
    throw new ApiError(response.status, 'UNKNOWN', 'Something went wrong. Please try again.');
  }
  return data as T;
}

export const api = {
  me: () => request<{ user: UserDto | null }>('GET', '/auth/me'),
  login: (input: LoginInput) => request<{ user: UserDto }>('POST', '/auth/login', input),
  register: (input: RegisterInput) => request<{ user: UserDto }>('POST', '/auth/register', input),
  logout: () => request<null>('POST', '/auth/logout'),
  balances: () => request<{ balances: BalanceDto[] }>('GET', '/balances'),
  orders: (status: 'open' | 'closed') =>
    request<{ orders: OrderDto[] }>('GET', `/orders?status=${status}&limit=50`),
  placeOrder: (input: PlaceOrderInput) => request<{ order: OrderDto }>('POST', '/orders', input),
  cancelOrder: (id: string) => request<{ order: OrderDto }>('DELETE', `/orders/${id}`),
};
