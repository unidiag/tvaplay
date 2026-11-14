import useFeedback from '../hooks/useFeedback';
import React, {
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  MenuItem,
  FormControl,
  Select,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
  Switch,
} from '@mui/material';
import { Add as AddIcon } from '@mui/icons-material';
import { apiRequest } from '../utils/api';
const TOKEN_KEY = 'tvaplay_access_token';
const RECORD_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 24, label: '1 day' },
  { value: 48, label: '2 days' },
  { value: 72, label: '3 days' },
  { value: 120, label: '5 days' },
  { value: 168, label: '1 week' },
];
const emptyChannel = {
  id: 0,
  name: '',
  udp: '',
  record: 0,
  storage_id: 0,
  enable: 1,
  epgid: '',
  transcode: 0,
};
const normalizeChannel = (c) => ({
  ...c,
  id: Number(c.id),
  name: c.name || '',
  udp: c.udp || '',
  record: Number(c.record || 0),
  storage_id: Number(c.storage_id || 0),
  enable: Number(c.enable),
  epgid: c.epgid || '',
  icon: c.icon || '',
  epg_name: c.epg_name || '',
  transcode: Number(c.transcode || 0),
});
const formatArchiveSize = (bytes) => {
  if (bytes == null) return '—';
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size >= 1e12) return `${(size / 1e12).toFixed(2)} TB`;
  if (size >= 1e9) return `${(size / 1e9).toFixed(2)} GB`;
  if (size >= 1e6) return `${(size / 1e6).toFixed(1)} MB`;
  if (size >= 1e3) return `${(size / 1e3).toFixed(1)} KB`;
  return `${size} B`;
};
const messageOf = (err) =>
  err instanceof Error ? err.message : String(err);
function ChannelIcon({ src, name }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [src]);
  const iconURL = React.useMemo(() => {
    if (!src) return '';
    const url = String(src).trim();
    if (!url) return '';
    // Protocol-relative URLs, e.g. //example.com/icon.png
    if (url.startsWith('//')) {
      return `https:${url}`;
    }
    // Let the browser resolve relative paths.
    if (url.startsWith('/')) {
      return url;
    }
    // Prefer HTTPS when the page is served over HTTPS.
    if (
      window.location.protocol === 'https:' &&
      url.startsWith('http://')
    ) {
      return url.replace(/^http:\/\//, 'https://');
    }
    return url;
  }, [src]);
  return (
    <Box
      sx={{
        width: 24,
        height: 24,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {iconURL && !failed ? (
        <Box
          component="img"
          src={iconURL}
          alt={name || 'Channel'}
          title={name || ''}
          onError={() => {
            console.warn(
              '[Channels] Icon loading failed:',
              iconURL
            );
            setFailed(true);
          }}
          sx={{
            width: 24,
            height: 24,
            objectFit: 'contain',
            display: 'block',
          }}
        />
      ) : (
        <Typography
          sx={{ fontSize: 18, lineHeight: 1 }}
        >
          📺
        </Typography>
      )}
    </Box>
  );
}
export default function Channels() {
  const [channels, setChannels] = useState([]);
  const [epgChannels, setEPGChannels] = useState([]);
  const [storages, setStorages] = useState([]);
  const [archiveSizes, setArchiveSizes] = useState({});
  const [pendingMoveChoice, setPendingMoveChoice] = useState(null);
  const [moveTrackingID, setMoveTrackingID] = useState(null);
  const [moveStatus, setMoveStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { setError, setNotice } = useFeedback();
  const [editingID, setEditingID] = useState(null);
  const [draft, setDraft] = useState(null);
  const [adding, setAdding] = useState(false);
  const [newChannel, setNewChannel] = useState({
    ...emptyChannel,
  });
  const [draggedID, setDraggedID] = useState(null);
  const [dragOverID, setDragOverID] = useState(null);
  const request = useCallback(
    (op, params = {}) =>
      apiRequest(
        op,
        params,
        localStorage.getItem(TOKEN_KEY) || null
      ),
    []
  );
  // Archive directory sizes are calculated asynchronously on the server.
  // Only refresh these small cached values; do not reload the editable channel list.
  useEffect(() => {
    let mounted = true;
    const refreshSizes = async () => {
      try {
        const response = await request('adminChannelArchiveSizes');
        if (mounted && (!response.status || response.status === 'OK')) {
          setArchiveSizes(response.sizes || {});
        }
      } catch (err) {
        // Size monitoring must not prevent channel management.
        console.warn('[Channels] Cannot fetch archive sizes:', err);
      }
    };
    refreshSizes();
    const interval = window.setInterval(refreshSizes, 30000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [request]);
  const loadChannels = useCallback(async () => {
    const data = await request('adminChannels');
    setChannels(
      (data.channels || []).map(normalizeChannel)
    );
  }, [request]);
  const loadAll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [list, epg, storageList] = await Promise.all([
        request('adminChannels'),
        request('adminEPGChannels'),
        request('adminStorages'),
      ]);
      setChannels(
        (list.channels || []).map(normalizeChannel)
      );
      setEPGChannels(epg.channels || []);
      setStorages(storageList.storages || []);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [request, setError]);
  useEffect(() => {
    loadAll();
  }, [loadAll]);
  const updateDraft = (field, value) => {
    setDraft((prev) => ({
      ...prev,
      [field]: value,
    }));
  };
  const updateNewChannel = (field, value) => {
    setNewChannel((prev) => ({
      ...prev,
      [field]: value,
    }));
  };
  const startEditing = (channel) => {
    setAdding(false);
    setEditingID(channel.id);
    setDraft({ ...channel });
    setError('');
    setNotice('');
  };
  const cancelEditing = () => {
    setEditingID(null);
    setDraft(null);
  };
  const validateChannel = (channel) => {
    if (!channel.name.trim()) {
      throw new Error('Enter a channel name');
    }
    if (!channel.udp.trim()) {
      throw new Error('Enter a channel UDP address');
    }
    const record = Number(channel.record);
    if (!RECORD_OPTIONS.some((option) => option.value === record)) {
      throw new Error('Invalid recording retention period');
    }
    const storageID = Number(channel.storage_id || 0);
    const selectedStorage = storages.find((s) => Number(s.id) === storageID);
    if (record > 0 && (!selectedStorage || !selectedStorage.enabled)) {
      throw new Error('Select an enabled storage for recording');
    }
  };
  // Ask before changing the storage of an existing channel.
  // YES moves existing finalized recordings; NO only changes the assignment.
  const saveChannel = (channel, isNew = false) => {
    try {
      validateChannel(channel);
    } catch (err) {
      setError(messageOf(err));
      return;
    }
    const original = !isNew ? channels.find((c) => c.id === channel.id) : null;
    const oldID = Number(original?.storage_id || 0);
    const newID = Number(channel.storage_id || 0);
    if (original && oldID !== 0 && newID !== 0 && oldID !== newID) {
      setPendingMoveChoice({ channel: { ...channel }, isNew });
      return;
    }
    commitChannelSave(channel, isNew, false);
  };
  const commitChannelSave = async (channel, isNew = false, moveArchive = false) => {
    setPendingMoveChoice(null);
    try {
      validateChannel(channel);
      setSaving(true);
      setError('');
      setNotice('');
      const response = await request('adminChannelSave', {
        id: isNew ? 0 : channel.id,
        name: channel.name.trim(),
        udp: channel.udp.trim(),
        record: Number(channel.record),
        storage_id: Number(channel.storage_id || 0),
        enable: Number(channel.enable),
        transcode: Number(channel.transcode || 0),
        epgid: channel.epgid || '',
        move_archive: moveArchive ? 1 : 0,
      });
      if (response.status && response.status !== 'OK') {
        throw new Error(response.message || 'Cannot save channel.');
      }
      await loadChannels();
      if (isNew) {
        setAdding(false);
        setNewChannel({ ...emptyChannel });
        setNotice('Channel added.');
      } else {
        cancelEditing();
        if (response.move_error) {
          setError(`Channel saved, but archive transfer could not start: ${response.move_error}`);
        } else if (response.move_started) {
          setMoveTrackingID(channel.id);
          setMoveStatus({ state: 'waiting', moved: 0, total: 0 });
          setNotice('Channel saved. Archive transfer started in background.');
        } else {
          setNotice('Changes saved.');
        }
      }
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };
  useEffect(() => {
    if (moveTrackingID == null) return undefined;
    let active = true;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await request('adminChannelArchiveMoveStatus', {
          id: moveTrackingID,
        });
        if (!active) return;
        if (response.status && response.status !== 'OK') {
          throw new Error(response.message || 'Cannot load archive transfer status');
        }
        const job = response.job;
        if (job) {
          setMoveStatus(job);
          if (job.state === 'done' || job.state === 'error') {
            setMoveTrackingID(null);
            setMoveStatus(null);
            if (job.state === 'done') {
              setNotice(`Archive transfer completed: ${job.moved || 0} files.`);
            } else {
              setError(`Archive transfer stopped: ${job.error || 'unknown error'}. ${job.moved || 0} files moved.`);
            }
          }
        }
      } catch (err) {
        if (active) console.warn('[Channels] Archive transfer status:', err);
      } finally {
        busy = false;
      }
    };
    poll();
    const timer = window.setInterval(poll, 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, [request, moveTrackingID, setError, setNotice]);







const toggleTranscode = async (channel, checked) => {
  if (saving) return;

  const updated = {
    ...channel,
    transcode: checked ? 1 : 0,
  };

  const previous = channels;

  // Обновляем интерфейс сразу.
  setChannels((rows) =>
    rows.map((row) =>
      row.id === channel.id ? updated : row
    )
  );

  setSaving(true);
  setError('');
  setNotice('');

  try {
    const response = await request('adminChannelSave', {
      id: updated.id,
      name: updated.name,
      udp: updated.udp,
      record: updated.record,
      storage_id: Number(updated.storage_id || 0),
      enable: updated.enable,
      transcode: Number(updated.transcode || 0),
      epgid: updated.epgid,
    });

    if (response.status && response.status !== 'OK') {
      throw new Error(
        response.message || 'Cannot update channel.'
      );
    }

    setNotice(
      checked
        ? 'Video transcoding enabled.'
        : 'Video transcoding disabled.'
    );
  } catch (err) {
    setChannels(previous);
    setError(messageOf(err));
  } finally {
    setSaving(false);
  }
};










const toggleEnable = async (channel, checked) => {
  if (saving) return;

  const updated = {
    ...channel,
    enable: checked ? 1 : 0,
  };

  const previous = channels;

  // Обновляем состояние интерфейса сразу.
  setChannels((rows) =>
    rows.map((row) =>
      row.id === channel.id ? updated : row
    )
  );

  setSaving(true);
  setError('');
  setNotice('');

  try {
    const response = await request('adminChannelSave', {
      id: updated.id,
      name: updated.name,
      udp: updated.udp,
      record: Number(updated.record),
      storage_id: Number(updated.storage_id || 0),
      enable: updated.enable,
      transcode: Number(updated.transcode || 0),
      epgid: updated.epgid || '',
    });

    if (response.status && response.status !== 'OK') {
      throw new Error(
        response.message || 'Cannot update channel.'
      );
    }

    setNotice(
      checked ? 'Channel enabled.' : 'Channel disabled.'
    );
  } catch (err) {
    // Восстанавливаем прежнее состояние.
    setChannels(previous);
    setError(messageOf(err));
  } finally {
    setSaving(false);
  }
};






  const deleteChannel = async (channel) => {
    const confirmed = window.confirm(
      `Delete channel "${channel.name}" (ID ${channel.id})?`
    );
    if (!confirmed) return;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request('adminChannelDelete', {
        id: channel.id,
      });
      await loadChannels();
      if (editingID === channel.id) {
        cancelEditing();
      }
      setNotice('Channel deleted.');
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };
  const reorderChannels = async (sourceID, targetID) => {
    if (
      !sourceID ||
      !targetID ||
      sourceID === targetID ||
      saving ||
      editingID !== null ||
      adding
    ) {
      return;
    }
    const previous = [...channels];
    const reordered = [...channels];
    const sourceIndex = reordered.findIndex(
      (c) => c.id === sourceID
    );
    const targetIndex = reordered.findIndex(
      (c) => c.id === targetID
    );
    if (sourceIndex < 0 || targetIndex < 0) {
      return;
    }
    const [moved] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, moved);
    setChannels(reordered);
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request('adminChannelsOrder', {
        ids: reordered.map((c) => c.id),
      });
      setNotice('Channel order saved.');
    } catch (err) {
      setChannels(previous);
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };
  const handleDragStart = (event, channel) => {
    if (saving || adding || editingID !== null) {
      event.preventDefault();
      return;
    }
    setDraggedID(channel.id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(
      'text/plain',
      String(channel.id)
    );
  };
  const handleDragOver = (event, channel) => {
    if (!draggedID || saving) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverID(channel.id);
  };
  const handleDrop = (event, channel) => {
    event.preventDefault();
    const sourceID = draggedID;
    setDraggedID(null);
    setDragOverID(null);
    reorderChannels(sourceID, channel.id);
  };
  const resetDrag = () => {
    setDraggedID(null);
    setDragOverID(null);
  };
  const renderFields = (channel, onChange) => (
    <>
      <TableCell>
        <TextField
          fullWidth
          size="small"
          value={channel.name}
          onChange={(e) =>
            onChange('name', e.target.value)
          }
          placeholder="Channel name"
        />
      </TableCell>
      <TableCell>
        <TextField
          fullWidth
          size="small"
          value={channel.udp}
          onChange={(e) =>
            onChange('udp', e.target.value)
          }
          placeholder="udp://239.0.0.1:1234"
          sx={{ minWidth: 155 }}
        />
      </TableCell>
      <TableCell>
        <TextField
          select
          fullWidth
          size="small"
          value={Number(channel.record)}
          onChange={(e) =>
            onChange('record', Number(e.target.value))
          }
          sx={{ minWidth: 125 }}
        >
          {RECORD_OPTIONS.map((option) => (
            <MenuItem
              key={option.value}
              value={option.value}
            >
              {option.label}
            </MenuItem>
          ))}
        </TextField>
      </TableCell>
      <TableCell>
        <FormControl fullWidth size="small" sx={{ minWidth: 125 }}>
          <Select
            displayEmpty
            value={Number(channel.storage_id || 0)}
            onChange={(e) => onChange('storage_id', Number(e.target.value))}
          >
            <MenuItem value={0}>No storage</MenuItem>
            {storages.map((storage) => (
              <MenuItem key={storage.id} value={Number(storage.id)} disabled={!storage.enabled}>
                {storage.name}{!storage.enabled ? ' (disabled)' : ''}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </TableCell>
      {/* Archive size is read-only. A new channel has no directory yet. */}
      <TableCell sx={{ whiteSpace: 'nowrap' }}>
        <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
          {channel.id ? formatArchiveSize(archiveSizes[String(channel.id)]) : '—'}
        </Typography>
      </TableCell>
      <TableCell align="center">
        <Checkbox
          checked={Number(channel.enable) === 1}
          onChange={(e) =>
            onChange(
              'enable',
              e.target.checked ? 1 : 0
            )
          }
        />
      </TableCell>

      <TableCell align="center">
        <Tooltip title="Transcode video to H.264">
          <Switch
            size="small"
            checked={Number(channel.transcode) === 1}
            onChange={(event) =>
              onChange(
                'transcode',
                event.target.checked ? 1 : 0
              )
            }
          />
        </Tooltip>
      </TableCell>

      <TableCell>
        <TextField
          select
          fullWidth
          size="small"
          value={channel.epgid || ''}
          onChange={(e) =>
            onChange('epgid', e.target.value)
          }
          sx={{ minWidth: 155 }}
        >
          <MenuItem value="">
            No EPG
          </MenuItem>
          {epgChannels.map((epg) => (
            <MenuItem key={epg.id} value={epg.id}>
              {epg.name} ({epg.id})
            </MenuItem>
          ))}
        </TextField>
      </TableCell>
    </>
  );
  return (
    <Box>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 2,
          mb: 3,
        }}
      >
        <Box>
          <Typography variant="h5" fontWeight={600}>
            Channels
          </Typography>
          <Typography
            variant="body2"
            color="text.secondary"
          >
            Manage TV channels and their settings.
          </Typography>
        </Box>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 2,
          }}
        >
          <Chip
            size="small"
            label={`${channels.length} channels`}
            variant="outlined"
          />
          <Button
            size="small"
          variant="contained"
          startIcon={<AddIcon fontSize="small" />}
          sx={{
            height: 32,
            minHeight: 32,
            px: 1.5,
            py: 0,
            fontSize: '0.8125rem',
            lineHeight: 1,
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
          disabled={saving || adding}
            onClick={() => {
              cancelEditing();
              setAdding(true);
              setError('');
              setNotice('');
            }}
          >
            Add channel
          </Button>
        </Box>
      </Box>
      <Dialog
        open={pendingMoveChoice !== null}
        onClose={() => !saving && setPendingMoveChoice(null)}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>Move channel archive?</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2">
            The storage for <strong>{pendingMoveChoice?.channel?.name || ''}</strong> has changed.
            Move the existing archive files from the old storage to the new storage?
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            YES: save the channel and transfer finalized .ts files in the background.
            NO: save the channel without transferring old recordings.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setPendingMoveChoice(null)} disabled={saving}>Cancel</Button>
          <Button
            size="small"
            disabled={saving}
            onClick={() => pendingMoveChoice && commitChannelSave(pendingMoveChoice.channel, false, false)}
          >
            NO
          </Button>
          <Button
            variant="contained"
            size="small"
            disabled={saving}
            onClick={() => pendingMoveChoice && commitChannelSave(pendingMoveChoice.channel, false, true)}
          >
            YES
          </Button>
        </DialogActions>
      </Dialog>
      {moveStatus && moveStatus.state !== 'done' && moveStatus.state !== 'error' && (
        <Box sx={{ mb: 2, color: 'text.secondary', fontSize: '0.8125rem' }}>
          Moving channel archive: {moveStatus.moved || 0} / {moveStatus.total || '?'} files.
        </Box>
      )}
      {loading && (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      )}
      {/* Table */}
      {!loading && (
        <TableContainer
          component={Paper}
          variant="outlined"
        >
          <Table
            size="small"
            sx={{
              minWidth: 980,
              tableLayout: 'auto',
              '& .MuiTableCell-root': {
                px: 0.5,
                py: 0.25,
                fontSize: '0.8125rem',
                lineHeight: 1.25,
                verticalAlign: 'middle',
              },
              '& .MuiTableCell-head': {
                py: 0.75,
                fontWeight: 600,
                whiteSpace: 'nowrap',
              },
              '& .MuiTableCell-body .MuiButton-root': {
                minHeight: 26,
                minWidth: 0,
                px: 0.75,
                py: 0,
                fontSize: '0.75rem',
              },
              '& .MuiTableCell-body .MuiCheckbox-root': {
                p: 0.25,
              },
              '& .MuiTableCell-body .MuiSvgIcon-root': {
                fontSize: 19,
              },
              '& .MuiTableCell-body .MuiInputBase-root': {
                fontSize: '0.8125rem',
              },
              '& .MuiTableCell-body .MuiInputBase-input': {
                py: '6px',
                px: 1,
              },
              '& .MuiTableCell-body .MuiSelect-select': {
                py: '6px',
              },
            }}
          >
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 38 }}>
                  #
                </TableCell>
                <TableCell sx={{ width: 44 }}>
                  Icon
                </TableCell>
                <TableCell sx={{ width: 44 }}>
                  ID
                </TableCell>
                <TableCell>
                  Name
                </TableCell>
                <TableCell>
                  UDP
                </TableCell>
                <TableCell sx={{ width: 90, whiteSpace: 'nowrap' }}>
                  Recording
                </TableCell>
                <TableCell sx={{ minWidth: 125 }}>
                  Storage
                </TableCell>
                <TableCell sx={{ width: 90, whiteSpace: 'nowrap' }}>
                  Size
                </TableCell>
                <TableCell
                  align="center"
                  sx={{ width: 62 }}
                >
                  Enable
                </TableCell>

                <TableCell align="center" sx={{ width: 90 }}>
                  Transcode
                </TableCell>

                <TableCell>
                  EPG
                </TableCell>
                <TableCell
                  align="right"
                  sx={{ width: 120 }}
                >
                  Actions
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {/* Create a new channel */}
              {adding && (
                <TableRow
                  sx={{
                    bgcolor: 'action.hover',
                  }}
                >
                  <TableCell>+</TableCell>
                  <TableCell>
                    <ChannelIcon
                      src={
                        epgChannels.find(
                          (e) =>
                            e.id === newChannel.epgid
                        )?.icon || ''
                      }
                      name={newChannel.name}
                    />
                  </TableCell>
                  <TableCell>—</TableCell>
                  {renderFields(
                    newChannel,
                    updateNewChannel
                  )}
                  <TableCell align="right">
                    <Box
                      sx={{
                        display: 'flex',
                        gap: 1,
                        justifyContent: 'flex-end',
                      }}
                    >
                      <Button
                        size="small"
                        variant="contained"
                        disabled={saving}
                        onClick={() =>
                          saveChannel(newChannel, true)
                        }
                      >
                        Create
                      </Button>
                      <Button
                        size="small"
                        disabled={saving}
                        onClick={() => setAdding(false)}
                      >
                        Cancel
                      </Button>
                    </Box>
                  </TableCell>
                </TableRow>
              )}
              {/* Channel list */}
              {channels.map((channel, index) => {
                const editing =
                  editingID === channel.id;
                const current =
                  editing ? draft : channel;
                const epgIcon =
                  epgChannels.find(
                    (e) => e.id === current.epgid
                  )?.icon || channel.icon;
                return (
                  <TableRow
                    key={channel.id}
                    hover
                    draggable={
                      !saving &&
                      !adding &&
                      editingID === null
                    }
                    onDragStart={(event) =>
                      handleDragStart(event, channel)
                    }
                    onDragOver={(event) =>
                      handleDragOver(event, channel)
                    }
                    onDrop={(event) =>
                      handleDrop(event, channel)
                    }
                    onDragEnd={resetDrag}
                    sx={{
                      cursor: editing
                        ? 'default'
                        : 'grab',
                      opacity:
                        draggedID === channel.id
                          ? 0.5
                          : 1,
                      borderTop:
                        dragOverID === channel.id &&
                        draggedID !== channel.id
                          ? '3px solid'
                          : undefined,
                      borderColor: 'primary.main',
                      '&:hover': {
                        bgcolor: 'action.hover',
                      },
                    }}
                  >
                    <TableCell>
                      <Tooltip title="Drag to reorder">
                        <Box
                          sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.5,
                            userSelect: 'none',
                          }}
                        >
                          <Typography
                            color="text.disabled"
                            sx={{
                              cursor: 'grab',
                              fontSize: 18,
                            }}
                          >
                            ≡
                          </Typography>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                          >
                            {index + 1}
                          </Typography>
                        </Box>
                      </Tooltip>
                    </TableCell>
                    <TableCell>
                      <ChannelIcon
                        src={epgIcon}
                        name={current.name}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography
                        variant="body2"
                        color="text.secondary"
                      >
                        {channel.id}
                      </Typography>
                    </TableCell>
                    {editing ? (
                      renderFields(
                        current,
                        updateDraft
                      )
                    ) : (
                      <>
                        <TableCell>
                          <Typography
                            variant="body2"
                            fontWeight={500}
                          >
                            {channel.name}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography
                            variant="body2"
                            sx={{
                              fontFamily: 'monospace',
                              fontSize: 12,
                              overflowWrap: 'anywhere',
                            }}
                          >
                            {channel.udp}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <RecordDots hours={channel.record} />
                        </TableCell>
                        <TableCell>
                          <Typography variant="body2">
                            {storages.find((s) => Number(s.id) === Number(channel.storage_id))?.name || '—'}
                          </Typography>
                        </TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>
                          <Tooltip title="Current archive directory size (updates approximately every 5 minutes)">
                            <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                              {formatArchiveSize(archiveSizes[String(channel.id)])}
                            </Typography>
                          </Tooltip>
                        </TableCell>
                        <TableCell align="center">
                          <Checkbox
                            checked={channel.enable === 1}
                            disabled={saving}
                            onChange={(event) =>
                              toggleEnable(
                                channel,
                                event.target.checked
                              )
                            }
                          />
                        </TableCell>


                        <TableCell align="center">
                          <Tooltip
                            title={
                              channel.transcode === 1
                                ? 'H.264 transcoding enabled'
                                : 'H.264 transcoding disabled'
                            }
                          >
                            <Switch
                              size="small"
                              color="primary"
                              checked={Number(channel.transcode) === 1}
                              disabled={saving}
                              onChange={(event) =>
                                toggleTranscode(
                                  channel,
                                  event.target.checked
                                )
                              }
                            />
                          </Tooltip>
                        </TableCell>


                        <TableCell>
                          {channel.epg_name ||
                            channel.epgid ||
                            '—'}
                        </TableCell>
                      </>
                    )}
                    <TableCell align="right">
                      {editing ? (
                        <Box
                          sx={{
                            display: 'flex',
                            justifyContent: 'flex-end',
                            gap: 1,
                          }}
                        >
                          <Button
                            size="small"
                            variant="contained"
                            disabled={saving}
                            onClick={() =>
                              saveChannel(current)
                            }
                          >
                            Save
                          </Button>
                          <Button
                            size="small"
                            disabled={saving}
                            onClick={cancelEditing}
                          >
                            Cancel
                          </Button>
                        </Box>
                      ) : (
                        <Box
                          sx={{
                            display: 'flex',
                            justifyContent: 'flex-end',
                            gap: 1,
                          }}
                        >
                          <Button
                            size="small"
                            disabled={saving || adding}
                            onClick={() =>
                              startEditing(channel)
                            }
                          >
                            Edit
                          </Button>
                          <Button
                            size="small"
                            color="error"
                            disabled={saving || adding}
                            onClick={() =>
                              deleteChannel(channel)
                            }
                          >
                            Delete
                          </Button>
                        </Box>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {channels.length === 0 && !adding && (
                <TableRow>
                  <TableCell
                    colSpan={12}
                    align="center"
                    sx={{ py: 5 }}
                  >
                    <Typography color="text.secondary">
                      No channels found.
                      Click “Add channel” to create one.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mt: 2 }}
      >
        Drag a row to change channel order.
        Changes are saved automatically.
      </Typography>
    </Box>
  );
}
function RecordDots({ hours }) {
  const days = Math.floor(Number(hours || 0) / 24);
  if (days <= 0) {
    return null;
  }
  return (
    <Tooltip title={`Archive: ${days} day(s) (${hours} h)`}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          minHeight: 16,
          whiteSpace: 'nowrap',
        }}
      >
        {Array.from({ length: days }, (_, index) => (
          <Box
            key={index}
            sx={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              bgcolor: 'success.main',
              flexShrink: 0,
            }}
          />
        ))}
      </Box>
    </Tooltip>
  );
}
