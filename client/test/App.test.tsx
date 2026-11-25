import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

const rate = (currency: string, value: string, extra = {}) => ({
  currency,
  rate: value,
  changePercent: '0.5111',
  rateDate: '2026-11-23',
  source: 'boi',
  fetchedAt: '2026-11-24T08:00:00.000Z',
  stale: false,
  ...extra,
});
const allRates = () => [rate('USD', '3.343'), rate('EUR', '3.665'), rate('GBP', '4.3785')];
const ok = (rates: unknown[] = allRates()) => new Response(JSON.stringify({ rates }));
const fail = () => new Response('{}', { status: 503 });

const okStatus = {
  unavailable: [] as { currency: string; reason: string }[],
  held: [] as string[],
  backupReady: true,
  lastSuccessAt: '2026-11-24T08:00:00.000Z',
  storage: 'ok',
};
let status: typeof okStatus | null;
/** Answers /api/rates; /api/status is answered from `status`. */
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  status = okStatus;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    if (input !== '/api/status') return fetchMock(input, init);
    return new Response(JSON.stringify(status), { status: status ? 200 : 404 });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('rates', () => {
  it('shows a loading state, then the three rates with their date', async () => {
    fetchMock.mockResolvedValue(ok());
    render(<App />);
    expect(screen.getByText('Loading rates…')).toBeTruthy();
    const usd = within(await screen.findByRole('article', { name: 'US dollar' }));
    expect(usd.getByText('3.343')).toBeTruthy();
    expect(usd.getByText('Published 23 Nov 2026')).toBeTruthy();
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(screen.queryByText('Stale')).toBeNull();
  });

  it('marks stale rates and explains why', async () => {
    fetchMock.mockResolvedValue(ok([rate('USD', '3.343', { stale: true }), ...allRates().slice(1)]));
    render(<App />);
    expect(await screen.findAllByText('Stale')).toHaveLength(1);
    expect(screen.getByText(/could not be confirmed/)).toBeTruthy();
  });

  it('marks backup rates as not from BOI', async () => {
    fetchMock.mockResolvedValue(
      ok([rate('USD', '3.3498', { stale: true, status: 'backup' }), ...allRates().slice(1)]),
    );
    render(<App />);
    expect(await screen.findByText('Backup')).toBeTruthy();
    expect(screen.getByText(/come from the European Central Bank/)).toBeTruthy();
    expect(screen.queryByText('Stale')).toBeNull();
  });

  it('ignores staleness of currencies that are not shown', async () => {
    fetchMock.mockResolvedValue(ok([...allRates(), rate('JPY', '0.021', { stale: true })]));
    render(<App />);
    await screen.findByText('3.343');
    expect(screen.queryByText(/could not be confirmed/)).toBeNull();
  });

  it('handles a missing currency and an unknown daily change', async () => {
    fetchMock.mockResolvedValue(ok([rate('USD', '3.343', { changePercent: null }), rate('EUR', '3.665')]));
    render(<App />);
    expect(await screen.findByText('Rate currently unavailable')).toBeTruthy();
    expect(screen.getByText('Daily change unavailable')).toBeTruthy();
  });
});

describe('status', () => {
  it('shows the source, the confirmation time and the system status', async () => {
    fetchMock.mockResolvedValue(ok());
    render(<App />);
    const usd = within(await screen.findByRole('article', { name: 'US dollar' }));
    expect(usd.getByText('Source: Bank of Israel')).toBeTruthy();
    expect(usd.getByText('Confirmed 24 Nov, 10:00')).toBeTruthy();
    expect(await screen.findByText('Working, last reached 24 Nov, 10:00')).toBeTruthy();
  });

  it('explains a blocked rate', async () => {
    status = { ...okStatus, held: ['USD'], unavailable: [{ currency: 'USD', reason: 'held' }] };
    fetchMock.mockResolvedValue(ok(allRates().slice(1)));
    render(<App />);
    expect(await screen.findByText('Blocked: an unusual change is waiting for confirmation.')).toBeTruthy();
    expect(screen.getByText('Unusual change waiting for confirmation: USD')).toBeTruthy();
  });

  it('explains why when every rate is blocked', async () => {
    status = {
      ...okStatus,
      unavailable: ['USD', 'EUR', 'GBP'].map((currency) => ({ currency, reason: 'expired' })),
    };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'NO_DATA' } }), { status: 503 }));
    render(<App />);
    expect(await screen.findAllByText('Blocked: the last known rate is too old to use.')).toHaveLength(3);
    expect(screen.queryByText('Convert')).toBeNull();
  });

  it('shows database and backup problems', async () => {
    status = { ...okStatus, storage: 'error', backupReady: false };
    fetchMock.mockResolvedValue(ok());
    render(<App />);
    expect(await screen.findByText(/Failing/)).toBeTruthy();
    expect(screen.getByText('No recent rate')).toBeTruthy();
  });

  it('works with an API that has no status', async () => {
    status = null;
    fetchMock.mockResolvedValue(ok());
    render(<App />);
    expect(await screen.findByText('3.343')).toBeTruthy();
    expect(screen.queryByText('System status')).toBeNull();
  });
});

describe('failures', () => {
  it('removes the rates when the API says they can no longer be used', async () => {
    vi.useFakeTimers();
    const noData = new Response(JSON.stringify({ error: { code: 'NO_DATA' } }), { status: 503 });
    fetchMock.mockResolvedValueOnce(ok()).mockResolvedValue(noData);
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('3.343')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.queryByText('3.343')).toBeNull();
    expect(screen.queryByText('Convert')).toBeNull();
    expect(screen.getByText('Exchange rates are unavailable right now.')).toBeTruthy();
  });

  it('shows an error and recovers on retry', async () => {
    fetchMock.mockResolvedValueOnce(fail()).mockResolvedValueOnce(ok());
    render(<App />);
    expect(await screen.findByText('Exchange rates are unavailable right now.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('3.343')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rejects a malformed response', async () => {
    fetchMock.mockResolvedValue(ok([rate('USD', '0')]));
    render(<App />);
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('keeps the rates on screen when a refresh fails', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(ok()).mockResolvedValue(fail());
    render(<App />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('3.343')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText(/Could not refresh/)).toBeTruthy();
    expect(screen.getByText('3.343')).toBeTruthy();
  });
});

describe('converter', () => {
  const result = () => document.querySelector('output')!.textContent;

  it('converts, changes currency and swaps direction', async () => {
    fetchMock.mockResolvedValue(ok());
    render(<App />);
    await screen.findByText('Convert');
    expect(result()).toBe('334.30 ILS');
    await userEvent.selectOptions(screen.getByLabelText('Currency'), 'GBP');
    expect(result()).toBe('437.85 ILS');
    await userEvent.click(screen.getByRole('button', { name: /Swap/ }));
    fireEvent.change(screen.getByLabelText('Amount in ILS'), { target: { value: '4378.5' } });
    expect(result()).toBe('1,000.00 GBP');
  });

  it('keeps the selected currency when its rate is missing', async () => {
    fetchMock.mockResolvedValue(ok(allRates().slice(1)));
    render(<App />);
    expect(await screen.findByText("USD can't be converted right now.")).toBeTruthy();
    expect(result()).toBe('—');
    expect(screen.queryByText(/Enter a positive number/)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Currency'), 'EUR');
    expect(result()).toBe('366.50 ILS');
  });

  it('explains an invalid amount, but not an empty one', async () => {
    fetchMock.mockResolvedValue(ok());
    render(<App />);
    const input = await screen.findByLabelText('Amount in USD');
    fireEvent.change(input, { target: { value: '-5' } });
    expect(screen.getByText(/Enter a positive number/)).toBeTruthy();
    expect(result()).toBe('—');
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.queryByText(/Enter a positive number/)).toBeNull();
  });
});
