import useFeedback from '../hooks/useFeedback';
import React, { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Switch,
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
  Add,
  DeleteOutlined,
  EditOutlined,
  StorageOutlined,
} from '@mui/icons-material';
import { apiRequest } from '../utils/api';
import StorageModal from '../components/StorageModal';
import StorageSmart from '../components/StorageSmart';
import StorageGraph from '../components/StorageGraph';
import InsightsIcon from '@mui/icons-material/Insights';

const TOKEN_KEY = 'tvaplay_access_token';

const emptyStorage = {
  id: 0,
  name: '',
  path: '',
  enabled: true,
};

const normalizeStorage = (storage) => ({
  id: Number(storage.id),
  name: String(storage.name || ''),
  path: String(storage.path || ''),
  size_used_bytes: storage.size_used_bytes == null ? null : Number(storage.size_used_bytes),
  size_total_bytes: storage.size_total_bytes == null ? null : Number(storage.size_total_bytes),
  size_error: String(storage.size_error || ''),
  enabled: storage.enabled === true ||
    storage.enabled === 1 ||
    storage.enabled === '1',
});

const formatStorageSize = (bytes) => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const tb = bytes / 1e12;
  return tb.toFixed(tb >= 10 ? 1 : 2);
};

const formatIOSpeed = (value) => {
  const speed = Number(value);
  if (!Number.isFinite(speed) || speed < 0) return '—';
  return `${(speed / 1048576).toFixed(2)} MiB/s`;
};

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

export default function Storages() {
  const { setError, setNotice } = useFeedback();
  const [storages, setStorages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [editingID, setEditingID] = useState(null);
  const [draft, setDraft] = useState({ ...emptyStorage });
  const { error: modalError, setError: setModalError } = useFeedback();
  const [smartStorage, setSmartStorage] = useState(null);
  const [graphStorage, setGraphStorage] = useState(null);
  const [storageIO, setStorageIO] = useState({});

  const request = useCallback(
    (op, params = {}) =>
      apiRequest(op, params, localStorage.getItem(TOKEN_KEY) || null),
    []
  );

  // Refresh cached, server-side rolling 60-second averages every 5 seconds.
  useEffect(() => {
    let active = true;
    let inFlight = false;

    const refresh = async () => {
      if (inFlight || !active) return;
      inFlight = true;
      try {
        const response = await request('adminStorageIO');
        if (!active) return;
        if (response.status && response.status !== 'OK') {
          throw new Error(response.message || 'Cannot load storage I/O.');
        }
        const values = {};
        (response.io || []).forEach((item) => {
          values[Number(item.id)] = item;
        });
        setStorageIO(values);
      } catch (err) {
        // I/O data is supplementary; keep CRUD functional on transient failures.
        if (active) setStorageIO({});
      } finally {
        inFlight = false;
      }
    };

    refresh();
    const interval = window.setInterval(refresh, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [request]);

  const loadStorages = useCallback(async () => {
    const response = await request('adminStorages');
    if (response.status && response.status !== 'OK') {
      throw new Error(response.message || 'Cannot load storages.');
    }
    setStorages((response.storages || []).map(normalizeStorage));
  }, [request]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    request('adminStorages')
      .then((response) => {
        if (!mounted) return;
        if (response.status && response.status !== 'OK') {
          throw new Error(response.message || 'Cannot load storages.');
        }
        setStorages((response.storages || []).map(normalizeStorage));
      })
      .catch((err) => {
        if (mounted) setError(errorMessage(err));
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => { mounted = false; };
  }, [request, setError]);

  const openNew = () => {
    setEditingID(null);
    setDraft({ ...emptyStorage });
    setModalError('');
    setOpen(true);
  };

  const openEdit = (storage) => {
    setEditingID(storage.id);
    setDraft({ ...storage });
    setModalError('');
    setOpen(true);
  };

  const closeModal = () => {
    if (saving) return;
    setOpen(false);
    setEditingID(null);
    setModalError('');
  };

  const updateDraft = (field, value) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  const saveStorage = async () => {
    const name = draft.name.trim();
    const path = draft.path.trim();

    if (!name) {
      setModalError('Storage name is required.');
      return;
    }
    if (!path.startsWith('/')) {
      setModalError('Storage path must be absolute.');
      return;
    }
    if (path.length > 512) {
      setModalError('Storage path must not exceed 512 bytes.');
      return;
    }
    if (storages.some((item) => item.path === path && item.id !== editingID)) {
      setModalError('Storage with this path already exists.');
      return;
    }

    setSaving(true);
    setError('');
    setModalError('');
    setNotice('');
    try {
      const response = await request('adminStorageSave', {
        id: editingID === null ? 0 : editingID,
        name,
        path,
        enabled: draft.enabled ? 1 : 0,
      });
      if (response.status && response.status !== 'OK') {
        throw new Error(response.message || 'Cannot save storage.');
      }
      await loadStorages();
      setOpen(false);
      setEditingID(null);
      setNotice(editingID === null
        ? 'Storage added successfully.'
        : 'Storage updated successfully.');
    } catch (err) {
      setModalError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteStorage = async (storage) => {
    if (saving) return;
    if (!window.confirm(
      `Delete storage "${storage.name}"?\n\nPath: ${storage.path}\n\nArchive files will not be deleted.`
    )) return;

    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await request('adminStorageDelete', { id: storage.id });
      if (response.status && response.status !== 'OK') {
        throw new Error(response.message || 'Cannot delete storage.');
      }
      await loadStorages();
      setNotice('Storage deleted successfully.');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleStorage = async (storage, enabled) => {
    if (saving) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await request('adminStorageSave', {
        id: storage.id,
        name: storage.name,
        path: storage.path,
        enabled: enabled ? 1 : 0,
      });
      if (response.status && response.status !== 'OK') {
        throw new Error(response.message || 'Cannot update storage.');
      }
      await loadStorages();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box>
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        spacing={2}
        sx={{ mb: 3, width: '100%' }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h5" fontWeight={700}>Storages</Typography>
          <Typography variant="body2" color="text.secondary">
            Manage storage locations for TV archive recordings.
          </Typography>
        </Box>
        <Button
          size="small"
          variant="contained"
          startIcon={<Add fontSize="small" />}
          onClick={openNew}
          disabled={loading || saving}
          sx={{
            ml: 'auto !important', flexShrink: 0, alignSelf: 'center',
            height: 32, minHeight: 32, px: 1.5, py: 0,
            fontSize: '0.8125rem', lineHeight: 1, whiteSpace: 'nowrap',
          }}
        >
          Add storage
        </Button>
      </Stack>

      
      

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 5 }}><CircularProgress /></Box>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 70 }}>ID</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Path</TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>Size</TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap', minWidth: 170 }}>I/O speed</TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap', minWidth: 120 }}>I/O load</TableCell>
                <TableCell align="center">Enabled</TableCell>
                <TableCell align="right" sx={{ width: 160 }}>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {storages.map((storage) => (
                <TableRow key={storage.id} hover>
                  <TableCell>{storage.id}</TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={1.5} alignItems="center">
                      <StorageOutlined fontSize="small" color="action" />
                      <Button
                        variant="text"
                        size="small"
                        onClick={() => setSmartStorage(storage)}
                        sx={{
                          textTransform: 'none',
                          fontWeight: 500,
                          justifyContent: 'flex-start',
                          p: 0,
                          minWidth: 0,
                          textAlign: 'left',
                        }}
                      >
                        {storage.name}
                      </Button>
                    </Stack>
                  </TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                      {storage.path}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ minWidth: 180, width: 200 }}>
                    {storage.size_used_bytes != null &&
                    Number(storage.size_total_bytes) > 0 ? (
                      <Tooltip title={storage.size_error || 'Used / total filesystem capacity'}>
                        <Box sx={{ position: 'relative', width: '100%', minWidth: 150 }}>
                          <LinearProgress
                            variant="determinate"
                            value={Math.min(100, Math.max(0,
                              Number(storage.size_used_bytes) / Number(storage.size_total_bytes) * 100
                            ))}
                            sx={{
                              height: 24,
                              borderRadius: 1,
                              backgroundColor: 'action.hover',
                              '& .MuiLinearProgress-bar': {
                                borderRadius: 1,
                                backgroundColor: (() => {
                                  const percent = Number(storage.size_used_bytes) /
                                    Number(storage.size_total_bytes) * 100;
                                  return percent >= 90 ? 'error.main' :
                                    percent >= 75 ? 'warning.main' : 'success.main';
                                })(),
                              },
                            }}
                          />
                          <Typography
                            variant="caption"
                            sx={{
                              position: 'absolute',
                              inset: 0,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontWeight: 600,
                              color: 'text.primary',
                              whiteSpace: 'nowrap',
                              fontSize: '0.75rem',
                              fontVariantNumeric: 'tabular-nums',
                              textShadow: '0 1px 2px rgba(255,255,255,0.5)',
                            }}
                          >
                            {`${formatStorageSize(storage.size_used_bytes)} / ${formatStorageSize(storage.size_total_bytes)} TB`}
                          </Typography>
                        </Box>
                      </Tooltip>
                    ) : (
                      <Tooltip title={storage.size_error || 'Storage size unavailable'}>
                        <Typography variant="body2" color="text.secondary">—</Typography>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {storageIO[storage.id]?.available ? (
                      <Tooltip title={`Rolling average over ${storageIO[storage.id].window_seconds.toFixed(0)} seconds. Device: ${storageIO[storage.id].device}`}>
                        <Box sx={{ fontVariantNumeric: 'tabular-nums' }}>
                          <Typography variant="body2" sx={{ fontSize: 12 }}>
                            R: {formatIOSpeed(storageIO[storage.id].read_bytes_per_sec)}
                          </Typography>
                          <Typography variant="body2" sx={{ fontSize: 12 }}>
                            W: {formatIOSpeed(storageIO[storage.id].write_bytes_per_sec)}
                          </Typography>
                        </Box>
                      </Tooltip>
                    ) : (
                      <Tooltip title={storageIO[storage.id]?.error || 'Collecting disk I/O samples...'}>
                        <Typography variant="body2" color="text.secondary">—</Typography>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell sx={{ minWidth: 120 }}>
                    {storageIO[storage.id]?.available &&
                    Number.isFinite(Number(storageIO[storage.id].util_percent)) ? (
                      <Tooltip title={`Average disk busy time over ${Number(storageIO[storage.id].window_seconds).toFixed(0)} seconds. Device: ${storageIO[storage.id].device}`}>
                        <Box sx={{ width: '100%', minWidth: 100 }}>
                          <Typography
                            variant="body2"
                            sx={{ fontSize: 12, mb: 0.5, fontVariantNumeric: 'tabular-nums' }}
                          >
                            {Math.max(0, Math.min(100, Number(storageIO[storage.id].util_percent))).toFixed(1)}%
                          </Typography>
                          <LinearProgress
                            variant="determinate"
                            value={Math.max(0, Math.min(100, Number(storageIO[storage.id].util_percent)))}
                            color={Number(storageIO[storage.id].util_percent) >= 90 ? 'error' :
                              Number(storageIO[storage.id].util_percent) >= 70 ? 'warning' : 'success'}
                            sx={{ height: 6, borderRadius: 1 }}
                          />
                        </Box>
                      </Tooltip>
                    ) : (
                      <Tooltip title={storageIO[storage.id]?.error || 'Collecting disk I/O samples...'}>
                        <Typography variant="body2" color="text.secondary">—</Typography>
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell align="center">
                    <Switch
                      size="small"
                      checked={storage.enabled}
                      disabled={saving}
                      onChange={(event) => toggleStorage(storage, event.target.checked)}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                      <Tooltip title="Storage history">
                        <IconButton size="small" onClick={() => setGraphStorage(storage)}>
                          <InsightsIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title="Edit storage">
                        <span>
                          <IconButton size="small" disabled={saving} onClick={() => openEdit(storage)}>
                            <EditOutlined fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Delete storage">
                        <span>
                          <IconButton size="small" color="error" disabled={saving}
                            onClick={() => deleteStorage(storage)}>
                            <DeleteOutlined fontSize="small" />
                          </IconButton>
                        </span>
                      </Tooltip>
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
              {storages.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ py: 6 }}>
                    <Stack spacing={1.5} alignItems="center">
                      <StorageOutlined sx={{ fontSize: 40, color: 'text.disabled' }} />
                      <Typography color="text.secondary" variant="body2">
                        No storage locations configured.
                      </Typography>
                      <Button size="small" onClick={openNew}>Add your first storage</Button>
                    </Stack>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <StorageGraph
        open={graphStorage !== null}
        storage={graphStorage}
        request={request}
        onClose={() => setGraphStorage(null)}
      />

      <StorageSmart
        open={smartStorage !== null}
        storage={smartStorage}
        request={request}
        onClose={() => setSmartStorage(null)}
      />

      <StorageModal
        open={open}
        editingID={editingID}
        draft={draft}
        error={modalError}
        saving={saving}
        onChange={updateDraft}
        onClose={closeModal}
        onSave={saveStorage}
      />
    </Box>
  );
}
