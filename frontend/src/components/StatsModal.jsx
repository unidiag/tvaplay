import React, { useEffect, useMemo, useState } from 'react';

import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Tooltip,
  Typography,
} from '@mui/material';

import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';
import TvOutlinedIcon from '@mui/icons-material/TvOutlined';

const COLUMNS = [
  { id: 'channel_name', label: 'Channel' },
  { id: 'view_type', label: 'Type' },
  { id: 'programme_title', label: 'Programme' },
  { id: 'ip_address', label: 'IP address' },
  { id: 'started_at', label: 'Started' },
  { id: 'duration_sec', label: 'Duration', align: 'right' },
];

const truncateTitle = (title, maxLength = 50) => {
  if (!title) return '—';

  const chars = Array.from(String(title));

  return chars.length > maxLength
    ? `${chars.slice(0, maxLength).join('')}...`
    : title;
};

const formatDate = value => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ru-RU');
};

const formatDuration = seconds => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const compareValues = (a, b, field) => {
  if (field === 'duration_sec') {
    return Number(a[field] ?? 0) - Number(b[field] ?? 0);
  }

  if (field === 'started_at') {
    const x = new Date(a.started_at || 0).getTime();
    const y = new Date(b.started_at || 0).getTime();
    return (Number.isFinite(x) ? x : 0) - (Number.isFinite(y) ? y : 0);
  }

  return String(a[field] ?? '').localeCompare(
    String(b[field] ?? ''),
    'ru',
    { numeric: true, sensitivity: 'base' }
  );
};

// Show the EPG channel logo, with a safe fallback for missing/broken images.
function ChannelLogo({ src, name }) {
  const [failed, setFailed] = useState(false);
  

  useEffect(() => {
    setFailed(false);
  }, [src]);

  const url = String(src || '').trim();
  const allowed = /^(https?:\/\/|\/)/i.test(url) && !url.startsWith('//');

  if (!allowed || failed) {
    return (
      <Box
        sx={{ width: 24, height: 24, display: 'grid', placeItems: 'center', flexShrink: 0 }}
      >
        <TvOutlinedIcon fontSize="small" color="disabled" />
      </Box>
    );
  }

  return (
    <Box
      component="img"
      src={url}
      alt={name || 'Channel'}
      loading="lazy"
      onError={() => setFailed(true)}
      sx={{ width: 24, height: 24, objectFit: 'contain', flexShrink: 0 }}
    />
  );
}

const isRecentlyActive = (lastSeenAt, now) => {
  if (!lastSeenAt) return false;

  const lastSeen = new Date(lastSeenAt).getTime();
  const diff = now - lastSeen;

  return Number.isFinite(lastSeen) &&
    diff >= 0 &&
    diff <= 60 * 1000;
};


// ISO-код страны → Emoji-флаг
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








export default function StatsModal({ open, user, session, request, onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [orderBy, setOrderBy] = useState('started_at');
  const [order, setOrder] = useState('desc');

  const userId = user?.id ?? session?.user_id;
  const sessionId = session?.id;
  const hasSession = Boolean(session);


  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!open) return undefined;

    setNow(Date.now());

    const timer = setInterval(() => {
      setNow(Date.now());
    }, 10000);

    return () => clearInterval(timer);
  }, [open]);


  useEffect(() => {
    if (!open || !userId) return undefined;

    let cancelled = false;
    setLoading(true);
    setError('');
    setItems([]);

    const params = hasSession
      ? { session_id: sessionId, limit: 30 }
      : { user_id: userId, limit: 30 };

    request('adminViewStats', params)
      .then(response => {
        if (!cancelled) {
          setItems(Array.isArray(response?.stats) ? response.stats : []);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, userId, sessionId, hasSession, request, refreshKey]);

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const result = compareValues(a, b, orderBy);
      return result !== 0
        ? (order === 'asc' ? result : -result)
        : Number(b.id) - Number(a.id);
    });
  }, [items, orderBy, order]);

  const handleSort = field => {
    if (orderBy === field) {
      setOrder(previous => (previous === 'asc' ? 'desc' : 'asc'));
    } else {
      setOrderBy(field);
      setOrder(field === 'started_at' ? 'desc' : 'asc');
    }
  };

  const renderCell = (item, field) => {
    switch (field) {
      case 'channel_name':
        return (
          <Tooltip title={`Channel ID: ${item.channel_id}`} arrow>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
              <ChannelLogo src={item.channel_icon} name={item.channel_name} />
              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                {item.channel_name || `#${item.channel_id}`}
              </Typography>
            </Box>
          </Tooltip>
        );

      case 'programme_title':
        return (
          <Tooltip
            title={item.programme_title || 'No programme'}
            arrow
          >
            <Typography
              variant="body2"
              sx={{ cursor: 'help', whiteSpace: 'nowrap' }}
            >
              {truncateTitle(item.programme_title)}
            </Typography>
          </Tooltip>
        );

      case 'view_type': {
        const isActive = isRecentlyActive(item.last_seen_at, now);

        return (
          <Chip
            size="small"
            variant={isActive ? 'filled' : 'outlined'}
            color={item.view_type === 'live' ? 'success' : 'primary'}
            label={item.view_type === 'live' ? 'Live' : 'Archive'}
          />
        );
      }

      case 'started_at':
        return formatDate(item.started_at);

      case 'duration_sec':
        return (
          <Box sx={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatDuration(item.duration_sec)}
          </Box>
        );

      case 'ip_address': {
        const ip = String(item.ip_address || '').trim();

        if (!ip) return '—';

        const country = String(item.country || '')
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

            <Typography variant="body2">
              {ip}
            </Typography>
          </Box>
        );
      }

      default:
        return item[field] ?? '—';
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xl">
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box sx={{ flex: 1 }}>
          Viewing statistics
          <Typography variant="body2" color="text.secondary">
            {session
              ? `Session #${session.id} · ${session.login || ''}`
              : `User #${user?.id} · ${user?.login || ''}`}
            {' · Last 30 records'}
          </Typography>
        </Box>

        <Tooltip title="Refresh">
          <span>
            <IconButton disabled={loading} onClick={() => setRefreshKey(n => n + 1)}>
              <RefreshIcon />
            </IconButton>
          </span>
        </Tooltip>
        <IconButton onClick={onClose} aria-label="Close">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {loading ? (
          <Box sx={{ p: 5, textAlign: 'center' }}>
            <CircularProgress />
          </Box>
        ) : (
          <TableContainer>
            <Table
              size="small"
              sx={{
                '& th': { fontWeight: 700, whiteSpace: 'nowrap' },
                '& td': { whiteSpace: 'nowrap' },
              }}
            >
              <TableHead>
                <TableRow>
                  {COLUMNS.map(column => (
                    <TableCell
                      key={column.id}
                      align={column.align || 'left'}
                      sortDirection={orderBy === column.id ? order : false}
                    >
                      <TableSortLabel
                        active={orderBy === column.id}
                        direction={orderBy === column.id ? order : 'asc'}
                        onClick={() => handleSort(column.id)}
                      >
                        {column.label}
                      </TableSortLabel>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>

              <TableBody>
                {sortedItems.map(item => (
                  <TableRow key={item.id} hover>
                    {COLUMNS.map(column => (
                      <TableCell key={column.id} align={column.align || 'left'}>
                        {renderCell(item, column.id)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

                {!sortedItems.length && !error && (
                  <TableRow>
                    <TableCell colSpan={COLUMNS.length} align="center" sx={{ py: 4 }}>
                      No viewing records found.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
