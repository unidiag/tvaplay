
import { useEffect, useState } from 'react';

const EPG_REFRESH_INTERVAL = 60_000;
const EPG_REQUEST_TIMEOUT = 15_000;

export default function useEPG() {
  const [programmes, setProgrammes] = useState({});
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let fetching = false;
    let clockOffset = 0;
    let requestController = null;

    const updateClock = () => {
      if (active) {
        setNow(Date.now() + clockOffset);
      }
    };

    const loadEPG = async () => {
      if (!active || fetching) return;

      fetching = true;

      const controller = new AbortController();
      requestController = controller;

      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, EPG_REQUEST_TIMEOUT);

      try {
        const started = Date.now();

        const response = await fetch(
          `${process.env.REACT_APP_URL || ''}/api`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              op: 'guestEPGNow',
            }),
            signal: controller.signal,
            cache: 'no-store',
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const json = await response.json();

        if (!active) return;

        const data = json.data;

        if (!data || data.status !== 'OK') {
          throw new Error(
            data?.error ||
            data?.status ||
            json.error ||
            'EPG API error'
          );
        }

        if (!Number.isFinite(data.server_time)) {
          throw new Error('Invalid EPG server time');
        }

        const received = Date.now();

        clockOffset =
          data.server_time - (started + received) / 2;

        setProgrammes(data.programmes || {});
        setError('');
        updateClock();

      } catch (err) {
        if (!active) return;

        if (timedOut) {
          setError('Таймаут загрузки EPG');
          console.error('[EPG] Request timeout');
        } else if (err.name !== 'AbortError') {
          setError(err.message || 'Ошибка EPG');
          console.error('[EPG] Request failed:', err);
        }
      } finally {
        clearTimeout(timeout);
        fetching = false;

        if (requestController === controller) {
          requestController = null;
        }
      }
    };

    loadEPG();

    const refreshTimer = setInterval(
      loadEPG,
      EPG_REFRESH_INTERVAL
    );

    const clockTimer = setInterval(
      updateClock,
      1000
    );

    return () => {
      active = false;
      requestController?.abort();

      clearInterval(refreshTimer);
      clearInterval(clockTimer);
    };
  }, []);

  return { programmes, now, error };
}
