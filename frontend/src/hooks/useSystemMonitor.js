
import { useEffect, useState } from 'react';
import { apiRequest } from '../utils/api';

const TOKEN_KEY = 'tvaplay_access_token';

export default function useSystemMonitor(
  operation,
  interval = 5000,
) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    let inFlight = false;

    setLoading(true);
    setError('');
    setData(null);

    const refresh = async () => {
      if (!active || inFlight) {
        return;
      }

      inFlight = true;

      try {
        const response = await apiRequest(
          operation,
          {},
          localStorage.getItem(TOKEN_KEY) || null,
        );

        if (!response || response.status !== 'OK') {
          throw new Error(
            response?.message ||
            'Cannot load system information.',
          );
        }

        if (active) {
          setData(response);
          setError('');
        }
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : String(err),
          );
        }
      } finally {
        inFlight = false;

        if (active) {
          setLoading(false);
        }
      }
    };

    refresh();

    const timer = window.setInterval(
      refresh,
      interval,
    );

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [operation, interval]);

  return {
    data,
    loading,
    error,
  };
}
