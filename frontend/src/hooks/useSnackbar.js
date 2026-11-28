import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Alert, Snackbar } from '@mui/material';

const SnackbarContext = createContext(null);

export function SnackbarProvider({ children }) {
  const [queue, setQueue] = useState([]);
  const nextID = useRef(0);
  const current = queue[0] || null;

  const notify = useCallback((message, severity = 'info') => {
    const text = String(message ?? '').trim();
    if (!text) return;

    const variant = ['success', 'error', 'warning', 'info'].includes(severity)
      ? severity
      : 'info';

    setQueue((previous) => [
      ...previous,
      { id: ++nextID.current, text, severity: variant },
    ]);
  }, []);

  // Remove the displayed notification immediately. The next message, if any,
  // receives a different key, so Snackbar remounts and resets its own timer.
  // This does not depend on transition onExited callbacks.
  const close = useCallback((event, reason) => {
    if (reason === 'clickaway') return;
    setQueue((previous) => previous.slice(1));
  }, []);

  const context = useMemo(() => ({
    notify,
    success: (message) => notify(message, 'success'),
    error: (message) => notify(message, 'error'),
    warning: (message) => notify(message, 'warning'),
    info: (message) => notify(message, 'info'),
  }), [notify]);

  return (
    <SnackbarContext.Provider value={context}>
      {children}
      <Snackbar
        key={current?.id ?? 'empty'}
        open={Boolean(current)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        autoHideDuration={current?.severity === 'error' ? 6500 : 4000}
        onClose={close}
        sx={{
          bottom: { xs: 16, sm: 24 },
          right: { xs: 16, sm: 24 },
          maxWidth: 'calc(100vw - 32px)',
          zIndex: (theme) => theme.zIndex.modal + 10,
        }}
      >
        <Alert
          onClose={close}
          severity={current?.severity || 'info'}
          variant="filled"
          elevation={6}
          sx={{
            width: '100%',
            minWidth: { sm: 320 },
            maxWidth: 640,
            overflowWrap: 'anywhere',
          }}
        >
          {current?.text || ''}
        </Alert>
      </Snackbar>
    </SnackbarContext.Provider>
  );
}

export default function useSnackbar() {
  const value = useContext(SnackbarContext);
  if (!value) {
    throw new Error('useSnackbar must be used inside SnackbarProvider');
  }
  return value;
}
