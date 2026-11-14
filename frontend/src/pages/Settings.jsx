import useFeedback from '../hooks/useFeedback';

import React, {
  useCallback,
  useEffect,
  useState,
} from 'react';

import {
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';

import {
  Add as AddIcon,
  Delete as DeleteIcon,
  Save as SaveIcon,
} from '@mui/icons-material';

import { apiRequest } from '../utils/api';

const TOKEN_KEY = 'tvaplay_access_token';
const KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;

const emptySetting = {
  key: '',
  value: '',
  description: '',
};

const messageOf = (err) =>
  err instanceof Error ? err.message : String(err);

export default function Settings() {
  const [settings, setSettings] = useState([]);
  const [values, setValues] = useState({});
  const [descriptions, setDescriptions] = useState({});

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { setError, setNotice } = useFeedback();

  const [adding, setAdding] = useState(false);
  const [newSetting, setNewSetting] = useState({
    ...emptySetting,
  });

  const request = useCallback(
    (op, params = {}) =>
      apiRequest(
        op,
        params,
        localStorage.getItem(TOKEN_KEY) || null
      ),
    []
  );

  const loadSettings = useCallback(async () => {
    const result = await request('adminSettings');
    setSettings(result.settings || []);
    setValues({});
    setDescriptions({});
  }, [request]);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError('');

      try {
        const result = await request('adminSettings');
        if (active) {
          setSettings(result.settings || []);
        }
      } catch (err) {
        if (active) setError(messageOf(err));
      } finally {
        if (active) setLoading(false);
      }
    }

    load();

    return () => {
      active = false;
    };
  }, [request, setError]);

  const changeValue = (key, value) => {
    setValues(prev => ({
      ...prev,
      [key]: value,
    }));
  };

  const changeDescription = (key, value) => {
    setDescriptions(prev => ({
      ...prev,
      [key]: value,
    }));
  };

  const saveSetting = async (setting) => {
    setSaving(true);
    setError('');
    setNotice('');

    try {
      await request('adminSettingSave', {
        key: setting.key,
        value: values[setting.key] ?? setting.value,
        description:
          descriptions[setting.key] ??
          setting.description ??
          '',
      });

      await loadSettings();
      setNotice(`Setting "${setting.key}" saved successfully`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const addSetting = async () => {
    const key = newSetting.key.trim();

    if (!KEY_PATTERN.test(key)) {
      setError('Invalid setting key');
      return;
    }

    if (settings.some(s => s.key === key)) {
      setError('A setting with this key already exists');
      return;
    }

    setSaving(true);
    setError('');
    setNotice('');

    try {
      await request('adminSettingSave', {
        ...newSetting,
        key,
        create: true,
      });

      await loadSettings();
      setNewSetting({ ...emptySetting });
      setAdding(false);
      setNotice(`Setting "${key}" created successfully`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  const deleteSetting = async (setting) => {
    const confirmed = window.confirm(
      `Delete setting "${setting.key}"?`
    );

    if (!confirmed) return;

    setSaving(true);
    setError('');
    setNotice('');

    try {
      await request('adminSettingDelete', {
        key: setting.key,
      });

      await loadSettings();
      setNotice(`Setting "${setting.key}" deleted successfully`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box>
      <Stack
        direction="row"
        alignItems="center"
        justifyContent="space-between"
        sx={{ mb: 3, gap: 2, flexWrap: 'wrap', width: '100%' }}
      >
        <Box>
          <Typography variant="h5" fontWeight={600}>
            Settings
          </Typography>

          <Typography variant="body2" color="text.secondary">
            TVAPLAY system settings
          </Typography>
        </Box>

        <Button
          variant="contained"
          startIcon={<AddIcon />}
          sx={{ ml: 'auto', flexShrink: 0 }}
          disabled={loading || saving}
          onClick={() => setAdding(true)}
        >
          Add Setting
        </Button>
      </Stack>

      

      

      {loading ? (
        <Box sx={{ textAlign: 'center', py: 5 }}>
          <CircularProgress />
        </Box>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" sx={{ minWidth: 800 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: '20%' }}>
                  Key
                </TableCell>
                <TableCell sx={{ width: '40%' }}>
                  Value
                </TableCell>
                <TableCell>
                  Description
                </TableCell>
                <TableCell align="right">
                  Actions
                </TableCell>
              </TableRow>
            </TableHead>

            <TableBody>
              {settings.map(setting => {
                const value =
                  values[setting.key] ?? setting.value;

                const description =
                  descriptions[setting.key] ??
                  setting.description ??
                  '';

                const changed =
                  value !== setting.value ||
                  description !== (setting.description ?? '');

                return (
                  <TableRow key={setting.key}>
                    <TableCell>
                      <Typography
                        variant="body2"
                        fontWeight={600}
                      >
                        {setting.key}
                      </Typography>
                    </TableCell>

                    <TableCell>
                      <TextField
                        fullWidth
                        size="small"
                        value={value}
                        disabled={saving}
                        onChange={e =>
                          changeValue(setting.key, e.target.value)
                        }
                      />
                    </TableCell>

                    <TableCell>
                      <TextField
                        fullWidth
                        size="small"
                        value={description}
                        disabled={saving}
                        onChange={e =>
                          changeDescription(
                            setting.key,
                            e.target.value
                          )
                        }
                      />
                    </TableCell>

                    <TableCell align="right">
                      <Stack
                        direction="row"
                        spacing={1}
                        justifyContent="flex-end"
                      >
                        <Button
                          size="small"
                          variant="contained"
                          startIcon={<SaveIcon />}
                          disabled={!changed || saving}
                          onClick={() => saveSetting(setting)}
                        >
                          Save
                        </Button>

                        <Button
                          size="small"
                          color="error"
                          disabled={saving}
                          onClick={() => deleteSetting(setting)}
                        >
                          <DeleteIcon />
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                );
              })}

              {settings.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={4}
                    align="center"
                    sx={{ py: 5 }}
                  >
                    No settings found
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog
        open={adding}
        onClose={() => {
          if (!saving) setAdding(false);
        }}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          Add Setting
        </DialogTitle>

        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <TextField
              fullWidth
              label="Key"
              placeholder="epglink"
              value={newSetting.key}
              disabled={saving}
              onChange={e =>
                setNewSetting(prev => ({
                  ...prev,
                  key: e.target.value,
                }))
              }
              helperText="Lowercase Latin letters, digits, underscores, hyphens and dots"
            />

            <TextField
              fullWidth
              label="Value"
              value={newSetting.value}
              disabled={saving}
              onChange={e =>
                setNewSetting(prev => ({
                  ...prev,
                  value: e.target.value,
                }))
              }
            />

            <TextField
              fullWidth
              label="Description"
              value={newSetting.description}
              disabled={saving}
              onChange={e =>
                setNewSetting(prev => ({
                  ...prev,
                  description: e.target.value,
                }))
              }
            />
          </Stack>
        </DialogContent>

        <DialogActions>
          <Button
            disabled={saving}
            onClick={() => setAdding(false)}
          >
            Cancel
          </Button>

          <Button
            variant="contained"
            disabled={saving || !KEY_PATTERN.test(newSetting.key.trim())}
            onClick={addSetting}
          >
            Add
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
