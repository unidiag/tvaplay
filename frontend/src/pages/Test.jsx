
import React, { useState } from 'react';

import {
  Box,
  Paper,
  Typography,
  TextField,
  Button,
  Chip,
  Alert,
  Divider,
  CircularProgress,
  FormControlLabel,
  Switch,
  Tooltip,
} from '@mui/material';

import {
  Send as SendIcon,
  ContentCopy as CopyIcon,
  Clear as ClearIcon,
  DataObject as JsonIcon,
} from '@mui/icons-material';

// Адрес backend API.
// В development используем удалённый сервер,
// в production — относительный адрес.
const API_URL =
  process.env.REACT_APP_API_URL?.trim() ||
  (process.env.NODE_ENV === 'development'
    ? 'https://tv.trianda.by/api'
    : '/api');

const TOKEN_KEY = 'tvaplay_access_token';

const examples = {
  authMe: {},
  accountDevices: {},
  getEPGNow: {},
  guestHandshake: {},
};

const formatJSON = (value) =>
  JSON.stringify(value, null, 2);

const validateParams = (value) => {
  const data = JSON.parse(value);

  if (
    data === null ||
    Array.isArray(data) ||
    typeof data !== 'object'
  ) {
    throw new Error(
      'Параметры должны быть JSON-объектом'
    );
  }

  return data;
};

export default function Test() {
  const [op, setOp] = useState('authMe');
  const [params, setParams] = useState('{}');
  const [useJWT, setUseJWT] = useState(true);

  const [loading, setLoading] = useState(false);

  const [result, setResult] = useState(null);
  const [httpStatus, setHttpStatus] = useState(null);
  const [duration, setDuration] = useState(null);

  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [requestBody, setRequestBody] = useState('');

  const selectExample = (name) => {
    setOp(name);
    setParams(formatJSON(examples[name] || {}));
    setError('');
  };

  const formatParams = () => {
    try {
      const data = validateParams(params);

      setParams(formatJSON(data));
      setError('');
    } catch (err) {
      setError(
        `Некорректный JSON: ${err.message}`
      );
    }
  };

  const sendRequest = async () => {
    if (loading) return;

    setError('');
    setWarning('');
    setResult(null);
    setHttpStatus(null);
    setDuration(null);
    setRequestBody('');

    let data;

    try {
      if (!op.trim()) {
        throw new Error(
          'Укажите операцию API'
        );
      }

      const parsed = validateParams(params);

      // op задаётся отдельно от параметров.
      data = {
        ...parsed,
        op: op.trim(),
      };
    } catch (err) {
      setError(err.message);
      return;
    }

    const body = JSON.stringify(data);

    setRequestBody(formatJSON(data));

    const headers = {
      'Content-Type': 'application/json',
    };

    // Добавляем JWT при необходимости.
    if (useJWT) {
      const token = localStorage.getItem(
        TOKEN_KEY
      );

      if (token) {
        headers.Authorization = `Bearer ${token}`;
      } else {
        setWarning(
          'JWT не найден в localStorage. ' +
          'Запрос будет отправлен без Authorization.'
        );
      }
    }

    setLoading(true);

    const started = performance.now();

    try {

      const response = await fetch(API_URL, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body,
      });

      const elapsed = Math.round(
        performance.now() - started
      );

      setDuration(elapsed);
      setHttpStatus(response.status);

      const raw = await response.text();

      let parsed;

      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = {
          raw,
        };
      }

      setResult(parsed);

      if (!response.ok) {
        setError(
          `HTTP ${response.status} ${response.statusText}`
        );
      } else if (
        parsed?.data?.status &&
        parsed.data.status !== 'OK'
      ) {
        setWarning(
          `API: ${parsed.data.message || parsed.data.status}`
        );
      }
    } catch (err) {
      setError(
        `Ошибка запроса: ${err.message}`
      );
    } finally {
      setDuration((previous) =>
        previous === null
          ? Math.round(performance.now() - started)
          : previous
      );

      setLoading(false);
    }
  };

  const clearResult = () => {
    setResult(null);
    setHttpStatus(null);
    setDuration(null);
    setError('');
    setWarning('');
    setRequestBody('');
  };

  const copyResponse = async () => {
    if (result === null) return;

    try {
      await navigator.clipboard.writeText(
        formatJSON(result)
      );
    } catch (err) {
      setError(
        `Ошибка копирования: ${err.message}`
      );
    }
  };

  const handleKeyDown = (event) => {
    if (
      event.key === 'Enter' &&
      (event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault();
      sendRequest();
    }
  };

  const apiStatus = result?.data?.status;

  const isSuccess =
    httpStatus !== null &&
    httpStatus >= 200 &&
    httpStatus < 300 &&
    (
      apiStatus === undefined ||
      apiStatus === 'OK'
    );

  return (
    <Box>
      {/* Заголовок */}

      <Box
        sx={{
          display: 'flex',
          flexDirection: {
            xs: 'column',
            sm: 'row',
          },
          justifyContent: 'space-between',
          alignItems: {
            xs: 'flex-start',
            sm: 'center',
          },
          gap: 1,
          mb: 3,
        }}
      >
        <Box>
          <Typography
            variant="h5"
            fontWeight={600}
          >
            API Test
          </Typography>

          <Typography
            variant="body2"
            color="text.secondary"
          >
            Тестирование запросов к TVAPLAY Backend
          </Typography>
        </Box>

        <Chip
          label="POST"
          color="primary"
          variant="outlined"
        />
      </Box>

      {/* Адрес backend */}

      <Paper
        variant="outlined"
        sx={{ p: 2, mb: 3 }}
      >
        <Typography
          variant="caption"
          color="text.secondary"
        >
          Backend API URL
        </Typography>

        <Typography
          variant="body2"
          sx={{
            fontFamily: 'monospace',
            overflowWrap: 'anywhere',
            mt: 0.5,
          }}
        >
          {API_URL}
        </Typography>
      </Paper>

      {/* Форма запроса */}

      <Paper
        variant="outlined"
        sx={{ p: 3, mb: 3 }}
      >
        <Typography
          variant="h6"
          sx={{ mb: 2 }}
        >
          Запрос
        </Typography>

        <TextField
          fullWidth
          label="Операция API (op)"
          placeholder="authMe"
          value={op}
          onChange={(e) =>
            setOp(e.target.value)
          }
          onKeyDown={handleKeyDown}
          size="small"
          sx={{ mb: 2 }}
        />

        {/* Примеры операций */}

        <Box
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 1,
            mb: 3,
          }}
        >
          {Object.keys(examples).map((name) => (
            <Chip
              key={name}
              label={name}
              size="small"
              variant="outlined"
              onClick={() =>
                selectExample(name)
              }
            />
          ))}
        </Box>

        {/* JSON параметры */}

        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 1,
            mb: 1,
          }}
        >
          <Typography variant="subtitle2">
            Параметры JSON
          </Typography>

          <Button
            size="small"
            startIcon={<JsonIcon />}
            onClick={formatParams}
          >
            Форматировать
          </Button>
        </Box>

        <TextField
          multiline
          fullWidth
          minRows={8}
          maxRows={20}
          value={params}
          onChange={(e) =>
            setParams(e.target.value)
          }
          onKeyDown={handleKeyDown}
          placeholder='{"key": "value"}'
          slotProps={{
            input: {
              sx: {
                fontFamily: 'monospace',
                fontSize: 13,
              },
            },
          }}
        />

        {/* JWT */}

        <Box sx={{ mt: 2 }}>
          <FormControlLabel
            control={
              <Switch
                checked={useJWT}
                onChange={(e) =>
                  setUseJWT(e.target.checked)
                }
              />
            }
            label="Использовать JWT из TV UI"
          />
        </Box>

        <Divider sx={{ my: 2 }} />

        {/* Кнопки */}

        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 2,
          }}
        >
          <Button
            variant="contained"
            disabled={loading}
            startIcon={
              loading ? (
                <CircularProgress
                  size={18}
                  color="inherit"
                />
              ) : (
                <SendIcon />
              )
            }
            onClick={sendRequest}
          >
            {loading
              ? 'Отправка...'
              : 'Отправить'}
          </Button>

          <Button
            variant="outlined"
            color="inherit"
            startIcon={<ClearIcon />}
            onClick={clearResult}
          >
            Очистить
          </Button>

          <Typography
            variant="caption"
            color="text.secondary"
          >
            Ctrl+Enter — отправить запрос
          </Typography>
        </Box>
      </Paper>

      {/* Ошибки */}

      {error && (
        <Alert
          severity="error"
          onClose={() => setError('')}
          sx={{ mb: 2 }}
        >
          {error}
        </Alert>
      )}

      {warning && (
        <Alert
          severity="warning"
          onClose={() => setWarning('')}
          sx={{ mb: 2 }}
        >
          {warning}
        </Alert>
      )}

      {/* Отправленный JSON */}

      {requestBody && (
        <Paper
          variant="outlined"
          sx={{ p: 2, mb: 3 }}
        >
          <Typography
            variant="subtitle2"
            sx={{ mb: 1 }}
          >
            Отправленный JSON
          </Typography>

          <Box
            component="pre"
            sx={{
              m: 0,
              p: 2,
              bgcolor: 'action.hover',
              borderRadius: 1,
              overflow: 'auto',
              fontSize: 12,
              fontFamily: 'monospace',
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
            }}
          >
            {requestBody}
          </Box>
        </Paper>
      )}

      {/* Ответ сервера */}

      <Paper
        variant="outlined"
        sx={{ p: 3 }}
      >
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 2,
            mb: 2,
          }}
        >
          <Typography variant="h6">
            Ответ сервера
          </Typography>

          <Tooltip title="Копировать JSON">
            <span>
              <Button
                size="small"
                startIcon={<CopyIcon />}
                disabled={result === null}
                onClick={copyResponse}
              >
                Копировать
              </Button>
            </span>
          </Tooltip>
        </Box>

        {/* HTTP статус */}

        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 1,
            mb: 2,
          }}
        >
          {httpStatus !== null && (
            <Chip
              label={`HTTP ${httpStatus}`}
              size="small"
              color={
                isSuccess
                  ? 'success'
                  : 'error'
              }
            />
          )}

          {apiStatus && (
            <Chip
              label={`API: ${apiStatus}`}
              size="small"
              color={
                apiStatus === 'OK'
                  ? 'success'
                  : 'warning'
              }
              variant="outlined"
            />
          )}

          {duration !== null && (
            <Chip
              label={`${duration} ms`}
              size="small"
              variant="outlined"
            />
          )}
        </Box>

        {/* JSON ответ */}

        <Box
          component="pre"
          sx={{
            m: 0,
            p: 2,
            minHeight: 200,
            maxHeight: 600,
            overflow: 'auto',
            borderRadius: 1,
            bgcolor: 'action.hover',
            fontFamily: 'monospace',
            fontSize: 13,
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
          }}
        >
          {result !== null
            ? formatJSON(result)
            : '// Ответ пока не получен'}
        </Box>
      </Paper>
    </Box>
  );
}
