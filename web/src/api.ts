export interface ApiError {
  error: string;
  code: string;
  constraintRef?: string;
  detail?: unknown;
}

export class ApiFailure extends Error {
  constructor(readonly payload: ApiError, readonly status: number) {
    super(payload.error);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({ error: 'Unreadable response', code: 'PARSE' }));
  if (!res.ok) throw new ApiFailure(body as ApiError, res.status);
  return body as T;
}

export const api = {
  config: () => request<any>('/api/config'),
  startSession: (legalEntityId?: string) =>
    request<any>('/api/session', { method: 'POST', body: JSON.stringify({ legalEntityId }) }),
  session: () => request<any>('/api/session'),
  search: (criteria: unknown) =>
    request<any>('/api/search', { method: 'POST', body: JSON.stringify(criteria) }),
  hold: (offerIds: string[]) =>
    request<any>('/api/holds', { method: 'POST', body: JSON.stringify({ offerIds }) }),
  getHold: (id: string) => request<any>(`/api/holds/${id}`),
  token: () => request<{ token: string }>('/api/payment/token', { method: 'POST' }),
  book: (payload: unknown) =>
    request<any>('/api/bookings', { method: 'POST', body: JSON.stringify(payload) }),
  myBookings: () => request<any>('/api/bookings'),
  byReference: (ref: string) => request<any>(`/api/bookings/reference/${encodeURIComponent(ref)}`),
  cancelQuote: (id: string) => request<any>(`/api/bookings/${id}/cancellation-quote`),
  cancel: (id: string) => request<any>(`/api/bookings/${id}/cancel`, { method: 'POST' }),
  changeQuote: (id: string) => request<any>(`/api/bookings/${id}/change-quote`),
  nameChange: (id: string) => request<any>(`/api/bookings/${id}/name-change`, { method: 'POST' }),
  alerts: () => request<any>('/api/admin/alerts'),
  legHealth: () => request<any>('/api/admin/leg-health'),
  mock: (payload: unknown) =>
    request<any>('/api/mock/control', { method: 'POST', body: JSON.stringify(payload) }),
};

export function inr(paise: number): string {
  const whole = Math.round(paise / 100);
  const s = String(Math.abs(whole));
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${whole < 0 ? '-' : ''}₹${grouped}`;
}

export function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}
