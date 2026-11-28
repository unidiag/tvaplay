import { useCallback, useState } from 'react';
import useSnackbar from './useSnackbar';

// Transition helper for existing setError/setNotice-based pages and dialogs.
// Empty messages clear local status without opening a Snackbar.
export default function useFeedback() {
  const [error, setErrorState] = useState('');
  const [notice, setNoticeState] = useState('');
  const snackbar = useSnackbar();

  const setError = useCallback((message) => {
    const text = String(message ?? '');
    setErrorState(text);
    if (text.trim()) snackbar.error(text);
  }, [snackbar]);

  const setNotice = useCallback((message) => {
    const text = String(message ?? '');
    setNoticeState(text);
    if (text.trim()) snackbar.success(text);
  }, [snackbar]);

  return { error, notice, setError, setNotice };
}
