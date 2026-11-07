import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Chip, CircularProgress, IconButton, Paper, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  TextField, Tooltip, Typography,
} from '@mui/material';
import { EditOutlined, Search } from '@mui/icons-material';
import { apiRequest } from '../utils/api';
import User from '../components/UserModal';

const TOKEN_KEY = 'tvaplay_access_token';
const errorText = err => err instanceof Error ? err.message : String(err);

function statusName(value) {
  switch (Number(value)) {
    case 0: return 'Inactive';
    case 1: return 'Standard';
    case 2: return 'Premium';
    case 8: return 'Moderator (8)';
    case 9: return 'Admin (9)';
    default: return `Status ${value}`;
  }
}

export default function Users() {
  const [users, setUsers] = useState([]);
  const [currentUserStatus, setCurrentUserStatus] = useState(null);
  const [packages, setPackages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const request = useCallback((op, params = {}) =>
    apiRequest(op, params, localStorage.getItem(TOKEN_KEY) || null), []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [responseUsers, responsePackages] = await Promise.all([
        request('adminUsers'), request('adminPackages'),
      ]);
      setCurrentUserStatus(responseUsers.current_user_status == null
        ? null : Number(responseUsers.current_user_status));
      setUsers((responseUsers.users || []).map(u => ({
        ...u, id: Number(u.id), status: Number(u.status),
        max_dev: Number(u.max_dev),
        info: u.info || '', balance: String(u.balance ?? '0.00'),
        package_ids: (u.package_ids || []).map(Number),
      })));
      setPackages((responsePackages.packages || []).map(p => ({
        ...p, id: Number(p.id), enabled: Number(p.enabled),
      })));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => { reload(); }, [reload]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(user => String(user.id).includes(q) ||
      String(user.login || '').toLowerCase().includes(q));
  }, [users, search]);

  const save = async draft => {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      await request('adminUserSave', draft);
      await reload();
      setEditing(null);
      setNotice('User updated.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between"
        alignItems={{ xs: 'stretch', sm: 'center' }} spacing={2} sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>Users</Typography>
          <Typography variant="body2" color="text.secondary">
            Manage subscriber profiles and channel package assignments.
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', flex: 1 }}>
          <TextField size="small" placeholder="Search by login or ID" value={search}
            onChange={e => setSearch(e.target.value)} sx={{ width: 260, maxWidth: '100%' }}
            InputProps={{ startAdornment: <Search fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} /> }}
          />
        </Box>
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
                <TableCell>ID</TableCell>
                <TableCell>Login</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="center">Max devices</TableCell>
                <TableCell align="right">Balance</TableCell>
                <TableCell>Info</TableCell>
                <TableCell>Packages</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow></TableHead>
              <TableBody>
                {filteredUsers.map(user => (
                  <TableRow key={user.id} hover>
                    <TableCell>{user.id}</TableCell>
                    <TableCell>{user.login}</TableCell>
                    <TableCell><Chip size="small" variant="outlined" label={statusName(user.status)}
                      color={user.status === 0 ? 'default' : 'success'} /></TableCell>
                    <TableCell align="center">{user.max_dev}</TableCell>
                    <TableCell align="right">{user.balance}</TableCell>
                    <TableCell sx={{ maxWidth: 230 }}>
                      <Typography variant="body2" noWrap title={user.info}>
                        {user.info || '—'}
                      </Typography>
                    </TableCell>
                    <TableCell>{user.package_ids.map(id => packages.find(p => p.id === id)?.name || `#${id}`).join(', ') || '—'}</TableCell>
                    <TableCell align="right">
                      <Tooltip title="Edit user">
                        <span><IconButton size="small" onClick={() => setEditing(user)} disabled={saving}>
                          <EditOutlined fontSize="small" />
                        </IconButton></span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
                {!filteredUsers.length && (
                  <TableRow><TableCell colSpan={8} align="center" sx={{ py: 5 }}>
                    {users.length ? 'No matching users.' : 'No users found.'}
                  </TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Paper>
      <User open={Boolean(editing)} user={editing} packages={packages}
        saving={saving} currentUserStatus={currentUserStatus}
        onClose={() => setEditing(null)} onSave={save} />
    </Box>
  );
}
