import { useEffect, useState } from 'react';
import { parseM3U } from '../utils/parseM3U';

export default function usePlaylist() {
  const [state, setState] = useState({ loading: true, channels: [], epgUrl: '', error: '' });
  const [refreshToken, setRefreshToken] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState((prev) => ({ ...prev, loading: true, error: '' }));
      fetch(`${process.env.REACT_APP_URL || ""}/playlist.m3u`, {
        signal: controller.signal,
        cache: 'no-store'
      })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); })
      .then((body) => setState({ ...parseM3U(body), loading: false, error: '' }))
      .catch((err) => { if (err.name !== 'AbortError') setState((prev) => ({ ...prev, loading: false, error: err.message })); });
    return () => controller.abort();
  }, [refreshToken]);
  return { ...state, refresh: () => setRefreshToken((n) => n + 1) };
}
