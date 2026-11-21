import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Link,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  DeleteOutlined,
  RefreshOutlined,
  Search,
} from '@mui/icons-material';
import MovieFilterIcon from '@mui/icons-material/MovieFilter';
import StatsModal from '../components/StatsModal';
import { apiRequest } from '../utils/api';
import useFeedback from '../hooks/useFeedback';
const TOKEN_KEY = 'tvaplay_access_token';
const ROWS_PER_PAGE = 50;
const errorText = err =>
  err instanceof Error ? err.message : String(err);

// Форматирование даты

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

// ISO-код страны -> Emoji-флаг

function countryFlag(country) {
  const code = String(country || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) {
    return '🌐';
  }
  return String.fromCodePoint(
    ...Array.from(code).map(
      char => 127397 + char.charCodeAt(0)
    )
  );
}

const ONLINE_TIMEOUT = 10 * 60 * 1000;

function getSessionStatus(session, now = Date.now()) {
  const expiresAt = new Date(session.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return 'Expired';
  }
  const updatedAt = new Date(session.updated_at).getTime();
  const elapsed = now - updatedAt;
  if (
    Number.isFinite(updatedAt) &&
    elapsed >= 0 &&
    elapsed <= ONLINE_TIMEOUT
  ) {
    return 'Online';
  }
  return 'Active';
}

// Определение устройства по User-Agent

function deviceName(userAgent) {
  const ua = String(userAgent || '');
  let platform = 'Unknown device';
  let browser = '';
  if (/webOS|Web0S|NetCast/i.test(ua)) {
    platform = 'LG webOS';
  } else if (/Tizen/i.test(ua)) {
    platform = 'Samsung Tizen';
  } else if (/Android TV|Google TV/i.test(ua)) {
    platform = 'Android TV';
  } else if (/Android/i.test(ua)) {
    platform = 'Android';
  } else if (/Windows/i.test(ua)) {
    platform = 'Windows';
  } else if (/iPhone|iPad/i.test(ua)) {
    platform = 'iOS';
  } else if (/Macintosh|Mac OS/i.test(ua)) {
    platform = 'macOS';
  } else if (/Linux/i.test(ua)) {
    platform = 'Linux';
  }
  let match = ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/i);
  if (match) {
    browser = `Edge ${match[1]}`;
  } else {
    match = ua.match(/(?:Chrome|CriOS)\/([\d.]+)/i);
    if (match) {
      browser = `Chrome ${match[1]}`;
    } else {
      match = ua.match(/Firefox\/([\d.]+)/i);
      if (match) {
        browser = `Firefox ${match[1]}`;
      } else {
        match = ua.match(/Version\/([\d.]+).*Safari/i);
        if (match) {
          browser = `Safari ${match[1]}`;
        }
      }
    }
  }
  return browser
    ? `${platform} · ${browser}`
    : platform;
}

// Подсветка всех найденных подстрок

function Highlight({ value, query }) {
  const text = String(value ?? '');
  const needle = query.trim().toLowerCase();
  if (!needle) return text;
  const source = text.toLowerCase();
  const parts = [];
  let position = 0;
  let index;
  let key = 0;
  while (
    (index = source.indexOf(needle, position)) !== -1
  ) {
    if (index > position) {
      parts.push(text.substring(position, index));
    }
    parts.push(
      <Box
        component="mark"
        key={key++}
        sx={{
          backgroundColor: '#ffeb3b',
          color: '#212121',
          borderRadius: '2px',
          px: '1px',
          fontWeight: 600,
        }}
      >
        {text.substring(
          index,
          index + needle.length
        )}
      </Box>
    );
    position = index + needle.length;
  }
  if (position < text.length) {
    parts.push(text.substring(position));
  }
  return <>{parts}</>;
}

// Сортировка с учётом типа данных

function compareValues(a, b, field, now) {
    if (field === 'id') {
    return Number(a.id) - Number(b.id);
    }

  // Сортировка по статусу
  if (field === 'active') {
    const rank = {
      Expired: 0,
      Active: 1,
      Online: 2,
    };
    return (
      rank[getSessionStatus(a, now)] -
      rank[getSessionStatus(b, now)]
    );
  }

  // Сортировка по датам
  if (
    field === 'created_at' ||
    field === 'updated_at' ||
    field === 'expires_at'
  ) {
    const aTime = new Date(a[field]).getTime();
    const bTime = new Date(b[field]).getTime();
    return (
      (Number.isFinite(aTime) ? aTime : 0) -
      (Number.isFinite(bTime) ? bTime : 0)
    );
  }

  // Сортировка текстовых полей
  return String(a[field] ?? '').localeCompare(
    String(b[field] ?? ''),
    undefined,
    {
      numeric: true,
      sensitivity: 'base',
    }
  );
}

// Столбцы таблицы

const columns = [
  { id: 'login', label: 'Login' },
  { id: 'active', label: 'Status' },
  { id: 'device', label: 'Device' },
  { id: 'uid', label: 'UID' },
  { id: 'ip', label: 'IP address' },
  { id: 'created_at', label: 'Created' },
  { id: 'updated_at', label: 'Updated' },
  { id: 'expires_at', label: 'Expires' },
  { id: 'actions', label: '' },
];

export default function Sessions() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [orderBy, setOrderBy] = useState('id');
  const [order, setOrder] = useState('desc');
  const [deleteSession, setDeleteSession] = useState(null);
  const [viewingStats, setViewingStats] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const { setError } = useFeedback();
  const request = useCallback(
    (op, params = {}) =>
      apiRequest(
        op,
        params,
        localStorage.getItem(TOKEN_KEY) || null
      ),
    []
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => {
        setNow(Date.now());
    }, 30000);
    return () => clearInterval(timer);
    }, []);

  // Загрузка сессий
  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await request('adminSessions');
      const items = Array.isArray(response.sessions)
        ? response.sessions
        : [];
      setSessions(
        items.map(item => ({
          ...item,
          id: Number(item.id),
          user_id: Number(item.user_id),
          login: item.login || '',
          uid: item.uid || '',
          ip: item.ip || '',
          user_agent: item.user_agent || '',
          device: deviceName(item.user_agent),
          active: Boolean(item.active),
        }))
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [request, setError]);
  useEffect(() => {
    reload();
  }, [reload]);

  // Удаление сессии
  const handleDelete = async () => {
    if (!deleteSession || deleting) return;
    const sessionId = deleteSession.id;
    setDeleting(true);
    setError('');
    try {
        const response = await request('adminSessionDelete', {
        id: sessionId,
        });
        if (response?.status !== 'OK') {
        throw new Error(
            response?.message || 'Cannot delete session'
        );
        }
        setSessions(previous =>
        previous.filter(session => session.id !== sessionId)
        );
        setDeleteSession(null);
    } catch (err) {
        setError(errorText(err));
    } finally {
        setDeleting(false);
    }
    };

  // Статистика
  const stats = useMemo(() => {
    let active = 0;
    let online = 0;
    let expired = 0;
    sessions.forEach(session => {
        const status = getSessionStatus(session, now);
        if (status === 'Online') {
        online++;
        active++;
        } else if (status === 'Active') {
        active++;
        } else {
        expired++;
        }
    });
    return {
        total: sessions.length,
        online,
        active,
        expired,
    };
    }, [sessions, now]);

  // Поиск по всем отображаемым полям
  const filteredSessions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(session => {
      const values = [
        session.id,
        session.user_id,
        session.login,
        getSessionStatus(session, now),
        session.device,
        session.uid,
        session.ip,
        formatDate(session.created_at),
        formatDate(session.expires_at),
      ];
      return values.some(value =>
        String(value ?? '')
          .toLowerCase()
          .includes(q)
      );
    });
  }, [sessions, search, now]);

  // Сортировка
  const sortedSessions = useMemo(() => {
    return filteredSessions.slice().sort((a, b) => {
      const result = compareValues(a, b, orderBy, now);
      if (result !== 0) {
        return order === 'asc'
          ? result
          : -result;
      }
      return b.id - a.id;
    });
  }, [filteredSessions, orderBy, order, now]);

  // Пагинация
  const maxPage = Math.max(
    0,
    Math.ceil(
      sortedSessions.length / ROWS_PER_PAGE
    ) - 1
  );
  const currentPage = Math.min(page, maxPage);
  const visibleSessions = useMemo(() => {
    const start = currentPage * ROWS_PER_PAGE;
    return sortedSessions.slice(
      start,
      start + ROWS_PER_PAGE
    );
  }, [sortedSessions, currentPage]);

  // Изменение поискового запроса
  const handleSearch = event => {
    setSearch(event.target.value);
    setPage(0);
  };

  // Изменение сортировки
  const handleSort = field => {
    if (orderBy === field) {
      setOrder(previous =>
        previous === 'asc'
          ? 'desc'
          : 'asc'
      );
    } else {
      setOrderBy(field);
      setOrder('asc');
    }
    setPage(0);
  };

  // Закрытие диалога удаления
  const handleCloseDelete = () => {
    if (!deleting) {
      setDeleteSession(null);
    }
  };

  // Отображение содержимого ячейки
  const renderCell = (session, field) => {
    // Кнопки статистики и удаления
    if (field === 'actions') {
      return (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Tooltip title="Viewing statistics" arrow>
            <IconButton
              size="small"
              onClick={() => setViewingStats(session)}
              aria-label={`Viewing statistics for session ${session.id}`}
            >
              <MovieFilterIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title="Delete session" arrow>
            <IconButton
              size="small"
              color="error"
              onClick={() => setDeleteSession(session)}
              aria-label={`Delete session ${session.id}`}
              disabled={deleting}
            >
              <DeleteOutlined fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      );
    }

    // Статус
    if (field === 'active') {
        const status = getSessionStatus(session, now);
        const color =
            status === 'Online'
            ? 'success'
            : status === 'Active'
                ? 'primary'
                : 'default';
        return (
            <Chip
            size="small"
            variant={status === 'Online' ? 'filled' : 'outlined'}
            color={color}
            label={
                <Highlight
                value={status}
                query={search}
                />
            }
            />
        );
    }
    // Устройство
    if (field === 'device') {
      return (
        <Tooltip
          title={session.user_agent || ''}
          arrow
        >
          <Typography
            variant="body2"
            sx={{
              cursor: 'help',
              whiteSpace: 'nowrap',
            }}
          >
            <Highlight
              value={session.device}
              query={search}
            />
          </Typography>
        </Tooltip>
      );
    }
    // IP-адрес — ссылка на информацию об адресе
    // IP-адрес с флагом страны
    if (field === 'ip') {
    const ip = String(session.ip || '').trim();
    if (!ip) {
        return '—';
    }
    const country = String(session.country || '')
        .trim()
        .toUpperCase();
    return (
        <Box
        sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.75,
            whiteSpace: 'nowrap',
        }}
        >
        <Tooltip title={country || 'Unknown country'} arrow>
            <Box
            component="span"
            sx={{
                fontSize: '18px',
                lineHeight: 1,
                cursor: 'help',
            }}
            >
            {countryFlag(country)}
            </Box>
        </Tooltip>
        <Link
            href={`https://ip.tva.by/${encodeURIComponent(ip)}`}
            target="_blank"
            rel="noopener noreferrer"
            underline="hover"
            sx={{ fontWeight: 500 }}
        >
            <Highlight value={ip} query={search} />
        </Link>
        </Box>
    );
    }
    // Даты
    if (
      field === 'created_at' ||
      field === 'updated_at' ||
      field === 'expires_at'
    ) {
      return (
        <Box sx={{ whiteSpace: 'nowrap' }}>
          <Highlight
            value={formatDate(session[field])}
            query={search}
          />
        </Box>
      );
    }
    // UID
    if (field === 'uid') {
      return (
        <Typography
          variant="caption"
          sx={{
            fontFamily: 'monospace',
            overflowWrap: 'anywhere',
          }}
        >
          <Highlight
            value={session.uid || '—'}
            query={search}
          />
        </Typography>
      );
    }
    // Обычные поля
    return (
      <Highlight
        value={
          session[field] === ''
            ? '—'
            : session[field]
        }
        query={search}
      />
    );
  };
  return (
    <Box sx={{ width: '100%', minWidth: 0 }}>
      {/* Заголовок, статистика и поиск */}
      <Box
        sx={{
          display: 'flex',
          flexDirection: {
            xs: 'column',
            md: 'row',
          },
          alignItems: {
            xs: 'stretch',
            md: 'center',
          },
          justifyContent: 'space-between',
          gap: 2,
          mb: 3,
          width: '100%',
        }}
      >
        {/* Левая часть */}
        <Box sx={{ minWidth: 0 }}>
          <Typography
            variant="h5"
            fontWeight={700}
          >
            Sessions
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
          >
            View all subscriber sessions and connected devices.
          </Typography>
          <Stack
            direction="row"
            spacing={1}
            flexWrap="wrap"
            useFlexGap
            sx={{ mt: 1 }}
          >
            <Chip
              size="small"
              variant="outlined"
              label={`Total: ${stats.total}`}
            />
            <Chip
                size="small"
                color="success"
                variant="filled"
                label={`Online: ${stats.online}`}
            />
            <Chip
              size="small"
              color="primary"
              variant="outlined"
              label={`Active: ${stats.active}`}
            />
            <Chip
              size="small"
              variant="outlined"
              label={`Expired: ${stats.expired}`}
            />
            {search.trim() && (
              <Chip
                size="small"
                color="primary"
                variant="outlined"
                label={
                  `Found: ${filteredSessions.length}`
                }
              />
            )}
          </Stack>
        </Box>
        {/* Правая часть — поиск и обновление */}
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          justifyContent="flex-end"
          sx={{
            ml: {
              xs: 0,
              md: 'auto',
            },
            width: 'auto',
            maxWidth: '100%',
            flexShrink: 0,
          }}
        >
          <TextField
            size="small"
            placeholder="Search sessions..."
            value={search}
            onChange={handleSearch}
            sx={{
              width: 320,
              maxWidth: '100%',
              minWidth: 0,
            }}
            InputProps={{
              startAdornment: (
                <Search
                  fontSize="small"
                  sx={{
                    mr: 1,
                    color: 'text.secondary',
                  }}
                />
              ),
            }}
          />
          <Button
            variant="outlined"
            startIcon={<RefreshOutlined />}
            onClick={reload}
            disabled={loading}
            sx={{
              flexShrink: 0,
              whiteSpace: 'nowrap',
            }}
          >
            Refresh
          </Button>
        </Stack>
      </Box>
      {/* Таблица сессий */}
      <Paper variant="outlined">
        {loading ? (
          <Box
            sx={{
              p: 6,
              textAlign: 'center',
            }}
          >
            <CircularProgress />
          </Box>
        ) : (
          <>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    {columns.map(column => {
                      const isActions =
                        column.id === 'actions';
                      return (
                        <TableCell
                          key={column.id}
                          align={
                            isActions
                              ? 'center'
                              : 'left'
                          }
                          sx={{
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                            width: isActions
                              ? 96
                              : 'auto',
                          }}
                          sortDirection={
                            !isActions &&
                            orderBy === column.id
                              ? order
                              : false
                          }
                        >
                          {isActions ? (
                            <Tooltip title="Actions">
                              <DeleteOutlined
                                fontSize="small"
                                sx={{
                                  color: 'text.disabled',
                                  verticalAlign: 'middle',
                                }}
                              />
                            </Tooltip>
                          ) : (
                            <TableSortLabel
                              active={
                                orderBy === column.id
                              }
                              direction={
                                orderBy === column.id
                                  ? order
                                  : 'asc'
                              }
                              onClick={() =>
                                handleSort(column.id)
                              }
                            >
                              {column.label}
                            </TableSortLabel>
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {visibleSessions.map(session => (
                    <TableRow
                      key={session.id}
                      hover
                      sx={{
                        opacity: session.active
                          ? 1
                          : 0.65,
                        '&:last-child td': {
                          borderBottom: 0,
                        },
                      }}
                    >
                      {columns.map(column => (
                        <TableCell
                          key={column.id}
                          align={
                            column.id === 'actions'
                              ? 'center'
                              : 'left'
                          }
                          sx={
                            column.id === 'actions'
                              ? {
                                  width: 96,
                                  whiteSpace: 'nowrap',
                                }
                              : undefined
                          }
                        >
                          {renderCell(
                            session,
                            column.id
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                  {visibleSessions.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={columns.length}
                        align="center"
                        sx={{ py: 5 }}
                      >
                        <Typography
                          color="text.secondary"
                        >
                          {search.trim()
                            ? 'No matching sessions found.'
                            : 'No sessions found.'}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
            {/* Пагинация */}
            <TablePagination
              component="div"
              count={sortedSessions.length}
              page={currentPage}
              onPageChange={(_, nextPage) =>
                setPage(nextPage)
              }
              rowsPerPage={ROWS_PER_PAGE}
              rowsPerPageOptions={[50]}
              labelRowsPerPage="Rows per page:"
              showFirstButton
              showLastButton
            />
          </>
        )}
      </Paper>
      <StatsModal
        open={Boolean(viewingStats)}
        session={viewingStats}
        request={request}
        onClose={() => setViewingStats(null)}
      />
      {/* Подтверждение удаления сессии */}
      <Dialog
        open={Boolean(deleteSession)}
        onClose={handleCloseDelete}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>
          Delete session
        </DialogTitle>
        <DialogContent>
          <DialogContentText>
            Are you sure you want to delete session
            <strong> #{deleteSession?.id}</strong>
            {deleteSession?.login
              ? ` (${deleteSession.login})`
              : ''}
            ?
          </DialogContentText>
          <Typography
            variant="body2"
            color="text.secondary"
            sx={{ mt: 2 }}
          >
            The refresh session will be removed.
            The device may need to sign in again.
          </Typography>
        </DialogContent>
        <DialogActions
          sx={{
            px: 3,
            pb: 2,
          }}
        >
          <Button
            onClick={handleCloseDelete}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            startIcon={
              deleting
                ? (
                    <CircularProgress
                      size={16}
                      color="inherit"
                    />
                  )
                : <DeleteOutlined />
            }
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting
              ? 'Deleting...'
              : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
