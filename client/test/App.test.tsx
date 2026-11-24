import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';

const rate = (currency: string, value: string, extra = {}) => ({
  currency,
  rate: value,
  changePercent: '0.5111',
  rateDate: '2026-11-23',
  stale: false,
  ...extra,
});
const allRates = () => [rate('USD', '3.343'), rate('EUR', '3.665'), rate('GBP', '4.3785')];
const ok = (rates: unknown[] = allRates()) => new Response(JSON.stringify({ rates }));
const fail = () => new Response('{}', { status: 503 });

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
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
    expect(screen.getByText(/could not be reached/)).toBeTruthy();
  });

  it('ignores staleness of currencies that are not shown', async () => {
    fetchMock.mockResolvedValue(ok([...allRates(), rate('JPY', '0.021', { stale: true })]));
    render(<App />);
    await screen.findByText('3.343');
    expect(screen.queryByText(/could not be reached/)).toBeNull();
  });

  it('handles a missing currency and an unknown daily change', async () => {
    fetchMock.mockResolvedValue(ok([rate('USD', '3.343', { changePercent: null }), rate('EUR', '3.665')]));
    render(<App />);
    expect(await screen.findByText('Rate currently unavailable')).toBeTruthy();
    expect(screen.getByText('Daily change unavailable')).toBeTruthy();
  });
});

describe('failures', () => {
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
