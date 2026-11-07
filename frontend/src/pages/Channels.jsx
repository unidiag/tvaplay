
import React, {
  useCallback,
  useEffect,
  useState,
} from 'react';

import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  MenuItem,
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
} from '@mui/material';

import { Add as AddIcon } from '@mui/icons-material';

import { apiRequest } from '../utils/api';

const TOKEN_KEY = 'tvaplay_access_token';

const RECORD_OPTIONS = [
  { value: 0, label: 'Выкл' },
  { value: 24, label: '1 день' },
  { value: 48, label: '2 дня' },
  { value: 72, label: '3 дня' },
  { value: 120, label: '5 дней' },
  { value: 168, label: 'Неделя' },
];

const emptyChannel = {
  id: 0,
  name: '',
  udp: '',
  record: 0,
  enable: 1,
  epgid: '',
};

const normalizeChannel = (c) => ({
  ...c,
  id: Number(c.id),
  name: c.name || '',
  udp: c.udp || '',
  record: Number(c.record || 0),
  enable: Number(c.enable),
  epgid: c.epgid || '',
  icon: c.icon || '',
  epg_name: c.epg_name || '',
});

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

    // Ссылки вида //example.com/icon.png
    if (url.startsWith('//')) {
      return `https:${url}`;
    }

    // Относительные пути оставляем браузеру.
    if (url.startsWith('/')) {
      return url;
    }

    // На HTTPS-странице пробуем HTTPS вместо HTTP.
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

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

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
      const [list, epg] = await Promise.all([
        request('adminChannels'),
        request('adminEPGChannels'),
      ]);

      setChannels(
        (list.channels || []).map(normalizeChannel)
      );
      setEPGChannels(epg.channels || []);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, [request]);

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
      throw new Error('Укажите название канала');
    }

    if (!channel.udp.trim()) {
      throw new Error('Укажите UDP-адрес канала');
    }

    const record = Number(channel.record);

    if (!RECORD_OPTIONS.some((option) => option.value === record)) {
      throw new Error('Некорректный период записи');
    }
  };

  const saveChannel = async (channel, isNew = false) => {
    try {
      validateChannel(channel);

      setSaving(true);
      setError('');
      setNotice('');

      await request('adminChannelSave', {
        id: isNew ? 0 : channel.id,
        name: channel.name.trim(),
        udp: channel.udp.trim(),
        record: Number(channel.record),
        enable: Number(channel.enable),
        epgid: channel.epgid || '',
      });

      await loadChannels();

      if (isNew) {
        setAdding(false);
        setNewChannel({ ...emptyChannel });
        setNotice('Канал добавлен');
      } else {
        cancelEditing();
        setNotice('Изменения сохранены');
      }
    } catch (err) {
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

    // Сразу отражаем изменение в интерфейсе.
    setChannels((rows) =>
      rows.map((row) =>
        row.id === channel.id ? updated : row
      )
    );

    setSaving(true);
    setError('');
    setNotice('');

    try {
      await request('adminChannelSave', {
        id: updated.id,
        name: updated.name,
        udp: updated.udp,
        record: updated.record,
        enable: updated.enable,
        epgid: updated.epgid,
      });
    } catch (err) {
      setChannels(previous);
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteChannel = async (channel) => {
    const confirmed = window.confirm(
      `Удалить канал "${channel.name}" (ID ${channel.id})?`
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

      setNotice('Канал удалён');
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

      setNotice('Порядок каналов сохранён');
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
          placeholder="Название канала"
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
          sx={{ minWidth: 190 }}
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

      <TableCell>
        <TextField
          select
          fullWidth
          size="small"
          value={channel.epgid || ''}
          onChange={(e) =>
            onChange('epgid', e.target.value)
          }
          sx={{ minWidth: 190 }}
        >
          <MenuItem value="">
            Без EPG
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
      {/* Заголовок */}

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
            Управление телевизионными каналами
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
            label={`${channels.length} каналов`}
            variant="outlined"
          />

          <Button
            variant="contained"
            startIcon={<AddIcon />}
            disabled={saving || adding}
            onClick={() => {
              cancelEditing();
              setAdding(true);
              setError('');
              setNotice('');
            }}
          >
            Добавить канал
          </Button>
        </Box>
      </Box>



      {/* Ошибки и уведомления */}

      {error && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          onClose={() => setError('')}
        >
          {error}
        </Alert>
      )}

      {notice && (
        <Alert
          severity="success"
          sx={{ mb: 2 }}
          onClose={() => setNotice('')}
        >
          {notice}
        </Alert>
      )}

      {loading && (
        <Box sx={{ textAlign: 'center', py: 4 }}>
          <CircularProgress />
        </Box>
      )}

      {/* Таблица */}

      {!loading && (
        <TableContainer
          component={Paper}
          variant="outlined"
        >
          <Table
            size="small"
            sx={{
              minWidth: 1050,
              '& td': {
                verticalAlign: 'middle',
              },
            }}
          >
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 36 }}>
                  №
                </TableCell>

                <TableCell sx={{ width: 65 }}>
                  Иконка
                </TableCell>

                <TableCell sx={{ width: 65 }}>
                  ID
                </TableCell>

                <TableCell>
                  Название
                </TableCell>

                <TableCell>
                  UDP
                </TableCell>

                <TableCell sx={{ width: 110, whiteSpace: 'nowrap' }}>
                  Запись
                </TableCell>

                <TableCell
                  align="center"
                  sx={{ width: 80 }}
                >
                  Enable
                </TableCell>

                <TableCell>
                  EPG
                </TableCell>

                <TableCell
                  align="right"
                  sx={{ width: 180 }}
                >
                  Действия
                </TableCell>
              </TableRow>
            </TableHead>

            <TableBody>
              {/* Создание нового канала */}

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
                        Создать
                      </Button>

                      <Button
                        size="small"
                        disabled={saving}
                        onClick={() => setAdding(false)}
                      >
                        Отмена
                      </Button>
                    </Box>
                  </TableCell>
                </TableRow>
              )}

              {/* Список каналов */}

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
                      <Tooltip title="Перетащите для сортировки">
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
                            Сохранить
                          </Button>

                          <Button
                            size="small"
                            disabled={saving}
                            onClick={cancelEditing}
                          >
                            Отмена
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
                            Изменить
                          </Button>

                          <Button
                            size="small"
                            color="error"
                            disabled={saving || adding}
                            onClick={() =>
                              deleteChannel(channel)
                            }
                          >
                            Удалить
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
                    colSpan={9}
                    align="center"
                    sx={{ py: 5 }}
                  >
                    <Typography color="text.secondary">
                      Каналы отсутствуют.
                      Нажмите «Добавить канал».
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
        Для изменения порядка перетащите строку мышью.
        Изменения сохраняются автоматически.
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
    <Tooltip title={`Архив: ${days} дн. (${hours} ч)`}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          minHeight: 20,
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
