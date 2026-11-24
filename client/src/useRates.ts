import { useCallback, useEffect, useState } from 'react';
import { fetchRates, type Rate } from './api';

const REFRESH_MS = 60_000;

export function useRates() {
  const [rates, setRates] = useState<Rate[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [requestId, setRequestId] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    async function load() {
      setLoading(true);
      try {
        const next = await fetchRates(controller.signal);
        if (controller.signal.aborted) return;
        setRates(next);
        setFailed(false);
      } catch {
        if (controller.signal.aborted) return;
        // Rates already on screen stay there, with a warning.
        setFailed(true);
      }
      setLoading(false);
      // Scheduled after the response, so requests never overlap.
      timer = setTimeout(load, REFRESH_MS);
    }

    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [requestId]);

  const retry = useCallback(() => setRequestId((id) => id + 1), []);
  return { rates, failed, loading, retry };
}
