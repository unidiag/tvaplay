import useFeedback from '../hooks/useFeedback';
import React, { useEffect, useState } from 'react';
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
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  DeleteOutlined,
  DevicesOtherOutlined,
  RefreshOutlined,
} from '@mui/icons-material';
const errorText = err => err instanceof Error ? err.message : String(err);
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
const ONLINE_TIMEOUT = 10 * 60 * 1000;

function getSessionStatus(session, now = Date.now()) {
  const expiresAt = new Date(session.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return 'Expired';

  const updatedAt = new Date(session.updated_at).getTime();
  const elapsed = now - updatedAt;
  return Number.isFinite(updatedAt) && elapsed >= 0 && elapsed <= ONLINE_TIMEOUT
    ? 'Online'
    : 'Active';
}

// ISO 3166-1 alpha-2 -> Emoji flag.
function countryFlag(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '🌐';
  return String.fromCodePoint(
    ...Array.from(code).map(char => 127397 + char.charCodeAt(0))
  );
}

function deviceName(userAgent) {
  const ua = String(userAgent || '');
  let platform = 'Unknown device';
  let browser = '';
  if (/webOS|Web0S|NetCast/i.test(ua)) platform = 'LG webOS';
  else if (/Tizen/i.test(ua)) platform = 'Samsung Tizen';
  else if (/Android TV|Google TV/i.test(ua)) platform = 'Android TV';
  else if (/Android/i.test(ua)) platform = 'Android';
  else if (/Windows/i.test(ua)) platform = 'Windows';
  else if (/iPhone|iPad/i.test(ua)) platform = 'iOS';
  else if (/Macintosh|Mac OS/i.test(ua)) platform = 'macOS';
  else if (/Linux/i.test(ua)) platform = 'Linux';
  let match = ua.match(/Edg(?:e|A|iOS)?\/([\d.]+)/i);
  if (match) browser = `Edge ${match[1]}`;
  else {
    match = ua.match(/(?:Chrome|CriOS)\/([\d.]+)/i);
    if (match) browser = `Chrome ${match[1]}`;
    else {
      match = ua.match(/Firefox\/([\d.]+)/i);
      if (match) browser = `Firefox ${match[1]}`;
      else {
        match = ua.match(/Version\/([\d.]+).*Safari/i);
        if (match) browser = `Safari ${match[1]}`;
      }
    }
  }
  return browser ? `${platform} · ${browser}` : platform;
}
export default function UserSessions({ open, user, request, onClose, onChanged }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [deletingID, setDeletingID] = useState(null);
  const [confirmSession, setConfirmSession] = useState(null);
  const { setError } = useFeedback();
  const [details, setDetails] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!open) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, [open]);
  const userID = user?.id ?? null;
  useEffect(() => {
    if (!open || userID == null) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setSessions([]);
    setDetails(null);
    setConfirmSession(null);
    request('adminUserSessions', { id: String(userID) })
      .then(response => {
        if (cancelled) return;
        setSessions(Array.isArray(response.sessions) ? response.sessions : []);
        setNow(Date.now());
        setDetails(response);
      })
      .catch(err => {
        if (!cancelled) setError(errorText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, userID, request, refreshKey, setError]);
  const deleteSession = async () => {
    if (!confirmSession || deletingID !== null || userID == null) return;
    const sessionID = confirmSession.id;
    setDeletingID(sessionID);
    setError('');
    try {
      // Сервер обязан проверять принадлежность session_id выбранному user_id.
      const response = await request('adminUserSessionDelete', {
        id: String(userID),
        session_id: String(sessionID),
      });
      setSessions(current => current.filter(item => String(item.id) !== String(sessionID)));
      setDetails(current => current ? {
        ...current,
        active_sessions: Number(response.active_sessions ?? current.active_sessions),
      } : current);
      setConfirmSession(null);
      if (typeof onChanged === 'function') onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setDeletingID(null);
    }
  };
  const activeCount = details
    ? Number(details.active_sessions || 0)
    : Number(user?.active_sessions || 0);
  const maxDevices = details
    ? Number(details.max_dev || 0)
    : Number(user?.max_dev || 0);
  return (
    <>
      <Dialog open={open} onClose={deletingID !== null ? undefined : onClose} fullWidth maxWidth="xl" scroll="paper">
      <DialogTitle>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            alignItems: 'center',
            columnGap: 2,
            width: '100%',
          }}
        >
          {/* Левая часть */}
          <Stack
            direction="row"
            alignItems="center"
            spacing={1.5}
            sx={{ minWidth: 0 }}
          >
            <DevicesOtherOutlined color="primary" />

            <Typography variant="h6" component="span" noWrap>
              User sessions
            </Typography>

            <Chip
              size="small"
              variant="outlined"
              label={`${activeCount} / ${maxDevices}`}
              color={activeCount > maxDevices ? 'warning' : 'primary'}
            />
          </Stack>

          {/* Правая часть */}
          <Typography
            variant="subtitle1"
            fontWeight={600}
            noWrap
            sx={{
              justifySelf: 'end',
              textAlign: 'right',
            }}
          >
            {user?.login || '—'}
          </Typography>
        </Box>
      </DialogTitle>
        <DialogContent dividers>
          {loading ? (
            <Box sx={{ textAlign: 'center', py: 5 }}><CircularProgress /></Box>
          ) : (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Active: {activeCount} · Total session records: {sessions.length}
              </Typography>
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Status</TableCell>
                      <TableCell>Device</TableCell>
                      <TableCell>UID</TableCell>
                      <TableCell>IP address</TableCell>
                      <TableCell>Created</TableCell>
                      <TableCell>Updated</TableCell>
                      <TableCell>Expires</TableCell>
                      <TableCell align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {sessions.map(session => (
                      <TableRow key={session.id} hover sx={{ opacity: getSessionStatus(session, now) === 'Expired' ? 0.65 : 1 }}>
                        <TableCell>
                          {(() => {
                            const status = getSessionStatus(session, now);
                            return (
                              <Chip
                                size="small"
                                variant={status === 'Online' ? 'filled' : 'outlined'}
                                color={status === 'Online' ? 'success' : status === 'Active' ? 'primary' : 'default'}
                                label={status}
                              />
                            );
                          })()}
                        </TableCell>
                        <TableCell sx={{ minWidth: 190 }}>
                          <Tooltip title={session.user_agent || ''} arrow>
                            <Typography variant="body2" sx={{ cursor: 'help' }}>
                              {deviceName(session.user_agent)}
                            </Typography>
                          </Tooltip>
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" sx={{ fontFamily: 'monospace', overflowWrap: 'anywhere' }}>
                            {session.uid || '—'}
                          </Typography>
                        </TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>
                          {session.ip ? (
                            <Stack direction="row" alignItems="center" spacing={0.75}>
                            <Tooltip title={String(session.country || '').toUpperCase() || 'Unknown country'} arrow>
                              <Box component="span" sx={{ fontSize: 18, lineHeight: 1, display: 'inline-flex' }}>
                                {countryFlag(session.country)}
                              </Box>
                            </Tooltip>
                            <Link
                              href={`https://ip.tva.by/${encodeURIComponent(session.ip)}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              underline="hover"
                              sx={{ fontWeight: 500 }}
                            >
                              {session.ip}
                            </Link>
                          </Stack>
                          ) : '—'}
                        </TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(session.created_at)}</TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(session.updated_at)}</TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(session.expires_at)}</TableCell>
                        <TableCell align="right">
                          <Tooltip title="Delete session">
                            <span>
                              <IconButton
                                size="small"
                                color="error"
                                aria-label={`Delete session ${session.id}`}
                                disabled={deletingID !== null || loading}
                                onClick={() => setConfirmSession(session)}
                              >
                                {deletingID === session.id
                                  ? <CircularProgress size={18} />
                                  : <DeleteOutlined fontSize="small" />}
                              </IconButton>
                            </span>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                    {!sessions.length && (
                      <TableRow>
                        <TableCell colSpan={8} align="center" sx={{ py: 5 }}>
                          No sessions found.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button
            startIcon={<RefreshOutlined />}
            disabled={loading || deletingID !== null}
            onClick={() => setRefreshKey(v => v + 1)}
          >
            Refresh
          </Button>
          <Button disabled={deletingID !== null} onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>
      <Dialog
        open={Boolean(confirmSession)}
        onClose={deletingID !== null ? undefined : () => setConfirmSession(null)}
        maxWidth="xs"
        fullWidth
      >
        <DialogTitle>Delete session?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Session #{confirmSession?.id} (UID: {confirmSession?.uid || '—'}) will be revoked.
            The device will need to sign in again when its access token expires.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button disabled={deletingID !== null} onClick={() => setConfirmSession(null)}>
            Cancel
          </Button>
          <Button
            variant="contained"
            color="error"
            disabled={deletingID !== null}
            onClick={deleteSession}
            startIcon={deletingID !== null ? <CircularProgress size={16} color="inherit" /> : <DeleteOutlined />}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
