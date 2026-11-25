export const boiItem = (key: string, rate: unknown, unit: unknown = 1, lastUpdate = '2026-11-23T13:21:10.7104898Z') => ({
  key,
  currentExchangeRate: rate,
  currentChange: 0.511124474,
  unit,
  lastUpdate,
});

export const boiItems = () => [
  boiItem('USD', 3.343),
  boiItem('EUR', 3.665),
  boiItem('GBP', 4.3785),
  boiItem('JPY', 2.1026, 100),
  boiItem('LBP', 0.0004, 10),
];

export const boiBody = (items: unknown[] = boiItems()) => JSON.stringify({ exchangeRates: items });

export const sdmxBody = (date = '2026-11-23') =>
  [
    'SERIES_CODE,BASE_CURRENCY,COUNTER_CURRENCY,UNIT_MULT,COMMENTS,TIME_PERIOD,OBS_VALUE',
    `RER_GBP_ILS,GBP,ILS,0,"a, quoted comment",${date},4.4`,
    `RER_USD_ILS,USD,ILS,0,,${date},3.35`,
    `RER_EUR_ILS,EUR,ILS,0,,${date},3.67`,
  ].join('\n');

export const ecbBody = (date = '2026-11-23', usdPerEuro = '1.0939') => `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube>
    <Cube time='${date}'>
      <Cube currency='USD' rate='${usdPerEuro}'/>
      <Cube currency='GBP' rate='0.83673'/>
      <Cube currency='ILS' rate='3.6643'/>
      <Cube currency='HKD' rate='8.5'/>
    </Cube>
  </Cube>
</gesmes:Envelope>`;

export const json = (body = boiBody()) =>
  new Response(body, { headers: { 'content-type': 'application/json; charset=utf-8' } });
export const csv = (body = sdmxBody()) =>
  new Response(body, { headers: { 'content-type': 'text/csv;charset=UTF-8' } });
export const xml = (body = ecbBody()) => new Response(body, { headers: { 'content-type': 'text/xml' } });
export const status = (code: number) => new Response('', { status: code });

/** A fake fetch that answers each source through a replaceable handler. */
export function fakeUpstream() {
  const handlers = {
    boi: async (): Promise<Response> => json(),
    sdmx: async (): Promise<Response> => csv(),
    // Off unless a test turns it on.
    ecb: async (): Promise<Response> => status(503),
  };
  const calls = { boi: 0, sdmx: 0, ecb: 0 };
  const fetchFn: typeof fetch = async (input) => {
    const url = String(input);
    const source = url.includes('ecb.europa.eu') ? 'ecb' : url.includes('edge.boi.gov.il') ? 'sdmx' : 'boi';
    calls[source]++;
    return handlers[source]();
  };
  return { handlers, calls, fetchFn };
}
