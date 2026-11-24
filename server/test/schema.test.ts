import { describe, expect, it } from 'vitest';
import { InvalidUpstreamDataError, parseBoiResponse, parseSdmxResponse } from '../src/boi/schema.js';
import { toIsraelDate } from '../src/domain/rates.js';
import { boiBody, boiItem, boiItems, sdmxBody } from './helpers.js';

const find = (body: string, currency: string) =>
  parseBoiResponse(body).rates.find((r) => r.currency === currency);

describe('parseBoiResponse', () => {
  it('normalizes by unit without rounding or exponent notation', () => {
    expect(find(boiBody(), 'USD')).toMatchObject({ rate: '3.343', officialRate: '3.343', unit: 1 });
    expect(find(boiBody(), 'JPY')).toMatchObject({ rate: '0.021026', officialRate: '2.1026', unit: 100 });
    expect(find(boiBody(), 'LBP')?.rate).toBe('0.00004');
  });

  it('keeps digits that a float would lose', () => {
    const body = boiBody().replace('3.343', '3.3430000000000000000000001');
    expect(find(body, 'USD')?.rate).toBe('3.3430000000000000000000001');
  });

  it.each([
    ['not JSON', '<html>'],
    ['no exchangeRates', '{}'],
    ['empty list', boiBody([])],
    ['null', 'null'],
    ['duplicate currency', boiBody([...boiItems(), boiItem('USD', 9)])],
    ['missing GBP', boiBody(boiItems().filter((i) => i.key !== 'GBP'))],
    ['zero USD', boiBody([boiItem('USD', 0), ...boiItems().slice(1)])],
    ['negative USD', boiBody([boiItem('USD', -1), ...boiItems().slice(1)])],
    ['null USD', boiBody([boiItem('USD', null), ...boiItems().slice(1)])],
    ['text USD', boiBody([boiItem('USD', 'abc'), ...boiItems().slice(1)])],
    ['unexpected unit', boiBody([boiItem('USD', 3, 7), ...boiItems().slice(1)])],
    ['bad date', boiBody([boiItem('USD', 3, 1, 'yesterday'), ...boiItems().slice(1)])],
  ])('rejects the whole response: %s', (_name, body) => {
    expect(() => parseBoiResponse(body)).toThrow(InvalidUpstreamDataError);
  });

  it('drops only the bad entry when it is an optional currency', () => {
    const result = parseBoiResponse(boiBody([...boiItems().slice(0, 4), boiItem('LBP', 0, 10)]));
    expect(result.rejected).toEqual(['LBP']);
    expect(result.rates.map((r) => r.currency)).toEqual(['USD', 'EUR', 'GBP', 'JPY']);
  });
});

describe('parseSdmxResponse', () => {
  it('parses the CSV', () => {
    const { rates } = parseSdmxResponse(sdmxBody());
    expect(rates).toHaveLength(3);
    expect(rates.find((r) => r.currency === 'USD')).toMatchObject({
      rate: '3.35',
      rateDate: '2026-11-23',
      changePercent: null,
      source: 'boi-sdmx',
    });
  });

  it.each([
    ['empty', ''],
    ['missing currency', sdmxBody().split('\n').slice(0, 3).join('\n')],
    ['empty value', sdmxBody().replace('3.35', '')],
    ['different counter currency', sdmxBody().replace('USD,ILS', 'USD,EUR')],
    ['different multiplier', sdmxBody().replace('USD,ILS,0', 'USD,ILS,2')],
  ])('rejects: %s', (_name, body) => {
    expect(() => parseSdmxResponse(body)).toThrow(InvalidUpstreamDataError);
  });
});

it('derives the date in Israel time', () => {
  expect(toIsraelDate('2026-11-23T22:30:00Z')).toBe('2026-11-24');
});
