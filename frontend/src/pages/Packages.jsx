import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, IconButton, Paper, Stack,
  Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  Typography,
} from '@mui/material';
import { Add, Delete, EditOutlined } from '@mui/icons-material';
import { apiRequest } from '../utils/api';
import PackageModal from '../components/PackageModal';

const TOKEN_KEY = 'tvaplay_access_token';
const emptyPackage = {
  id: 0, name: '', code: '', description: '', monthly_price: '0.00',
  position: 0, enabled: 1, optional: false, for_new: false, channel_ids: [],
};
const errorText = err => err instanceof Error ? err.message : String(err);

export default function Packages() {
  const [packages, setPackages] = useState([]);
  const [channels, setChannels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState(false);
  const [editingPackage, setEditingPackage] = useState(null);

  const request = useCallback((op, params = {}) =>
    apiRequest(op, params, localStorage.getItem(TOKEN_KEY) || null), []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [p, c] = await Promise.all([request('adminPackages'), request('adminChannels')]);
      setPackages((p.packages || []).map(item => ({
        ...item, id: Number(item.id), enabled: Number(item.enabled),
        optional: Boolean(item.optional),
        for_new: Boolean(item.for_new),
        monthly_price: String(item.monthly_price ?? '0.00'),
        channel_ids: (item.channel_ids || []).map(Number),
      })));
      setChannels((c.channels || []).map(item => ({
        ...item, id: Number(item.id), position: Number(item.position || 0),
      })));
    } catch (err) { setError(errorText(err)); }
    finally { setLoading(false); }
  }, [request]);

  useEffect(() => { reload(); }, [reload]);

  const openNew = () => {
    setEditingPackage({ ...emptyPackage, position: packages.length + 1, channel_ids: [] });
    setError('');
    setOpen(true);
  };
  const openEdit = item => {
    setEditingPackage({ ...item, channel_ids: [...item.channel_ids] });
    setError('');
    setOpen(true);
  };
  const closeModal = () => {
    if (saving) return;
    setOpen(false);
    setEditingPackage(null);
  };

  const save = async draft => {
    setSaving(true); setError(''); setNotice('');
    try {
      await request('adminPackageSave', draft);
      setOpen(false);
      setEditingPackage(null);
      await reload();
      setNotice(draft.id ? 'Package updated.' : 'Package created.');
    } catch (err) {
      throw err; // The modal displays errors without closing.
    } finally { setSaving(false); }
  };

  const remove = async item => {
    if (!window.confirm(`Delete package "${item.name}"? This will remove its channel assignments.`)) return;
    setSaving(true); setError(''); setNotice('');
    try {
      await request('adminPackageDelete', { id: item.id });
      await reload();
      setNotice('Package deleted.');
    } catch (err) { setError(errorText(err)); }
    finally { setSaving(false); }
  };

  const changeEnabled = async (item, enabled) => {
    setSaving(true); setError(''); setNotice('');
    try {
      await request('adminPackageSave', {
        id: item.id, name: item.name, code: item.code,
        description: item.description || '', position: Number(item.position),
        monthly_price: String(item.monthly_price ?? '0.00'),
        enabled: enabled ? 1 : 0, optional: Boolean(item.optional),
        for_new: Boolean(item.for_new),
        channel_ids: item.channel_ids,
      });
      await reload();
    } catch (err) { setError(errorText(err)); }
    finally { setSaving(false); }
  };

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Packages</Typography>
          <Typography color="text.secondary" variant="body2">Manage channel packages and assignments.</Typography>
        </Box>
        <Button size="small" variant="contained" startIcon={<Add />}
          onClick={openNew} disabled={saving || loading} sx={{ ml: 'auto', flexShrink: 0 }}>
          Add package
        </Button>
      </Stack>
      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>{error}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>{notice}</Alert>}
      <Paper variant="outlined">
        {loading ? (
          <Box sx={{ p: 6, textAlign: 'center' }}><CircularProgress /></Box>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead><TableRow>
                <TableCell>ID</TableCell><TableCell>Name</TableCell><TableCell>Code</TableCell>
                <TableCell>Description</TableCell><TableCell align="right">Monthly price</TableCell>
                <TableCell align="center">Channels</TableCell><TableCell align="center">Optional</TableCell>
                <TableCell align="center">For new</TableCell>
                <TableCell align="center">Enabled</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow></TableHead>
              <TableBody>
                {packages.map(item => (
                  <TableRow key={item.id} hover>
                    <TableCell>{item.id}</TableCell>
                    <TableCell><Typography fontWeight={600}>{item.name}</Typography></TableCell>
                    <TableCell><Chip size="small" variant="outlined" label={item.code} /></TableCell>
                    <TableCell>{item.description || '—'}</TableCell>
                    <TableCell align="right">{Number(item.monthly_price || 0).toFixed(2)}</TableCell>
                    <TableCell align="center">{item.channel_ids.length}</TableCell>
                    <TableCell align="center">{item.optional ? 'Yes' : 'No'}</TableCell>
                    <TableCell align="center">{item.for_new ? 'Yes' : 'No'}</TableCell>
                    <TableCell align="center">
                      <Switch size="small" checked={item.enabled === 1} disabled={saving}
                        onChange={e => changeEnabled(item, e.target.checked)} />
                    </TableCell>
                    <TableCell align="right">
                      <IconButton aria-label="Edit package" size="small" onClick={() => openEdit(item)} disabled={saving}>
                        <EditOutlined fontSize="small" />
                      </IconButton>
                      <IconButton aria-label="Delete package" size="small" color="error"
                        onClick={() => remove(item)} disabled={saving}>
                        <Delete fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                ))}
                {!packages.length && (
                  <TableRow><TableCell colSpan={10} align="center" sx={{ py: 5 }}>
                    No packages yet. Click “Add package” to create one.
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>
      <PackageModal
        open={open}
        pkg={editingPackage}
        channels={channels}
        saving={saving}
        onClose={closeModal}
        onSave={save}
      />
    </Box>
  );
}
