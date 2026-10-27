
import { useEffect, useState } from 'react';

import ErrorPage from './ErrorPage';

const REQUEST_TIMEOUT = 15000;

export default function HandshakeGate({ children }) {
  const [state, setState] = useState({
    status: 'loading',
    ip: '',
    country: '?',
    error: '',
  });

  useEffect(() => {
    let active = true;

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT
    );

    const handshake = async () => {
      try {
        const response = await fetch(
          `${process.env.REACT_APP_URL || ''}/api`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            credentials: 'omit',
            body: JSON.stringify({
              op: 'guestHandshake',
            }),
            cache: 'no-store',
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const json = await response.json();
        const data = json.data;

        if (
          !data ||
          data.status !== 'OK' ||
          typeof data.allowed !== 'boolean'
        ) {
          throw new Error('Некорректный ответ сервера');
        }

        if (!active) return;

        setState({
          status: data.allowed ? 'allowed' : 'denied',
          ip: data.ip || '',
          country: data.country || '?',
          error: '',
        });

      } catch (err) {
        if (!active) return;

        setState({
          status: 'error',
          ip: '',
          country: '?',
          error:
            err.name === 'AbortError'
              ? 'Сервер не отвечает'
              : 'Не удалось соединиться с сервером',
        });

        console.error('[Handshake]', err);

      } finally {
        clearTimeout(timeout);
      }
    };

    handshake();

    return () => {
      active = false;
      clearTimeout(timeout);
      controller.abort();
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="login-root">
        <div className="login-form">
          <img
            src="/logo192.png"
            alt="TVAPLAY"
            className="login-logo"
          />
          <h1>TVAPLAY</h1>
          <p className="login-description">
            Подключение к серверу...
          </p>
        </div>
      </div>
    );
  }

  if (state.status === 'denied') {
    return (
      <ErrorPage
        ip={state.ip}
        country={state.country}
      />
    );
  }

  if (state.status === 'error') {
    return <ErrorPage message={state.error} />;
  }

  return children;
}
