import useFeedback from '../hooks/useFeedback';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Box, Button, Checkbox, Dialog, DialogActions, DialogContent,
  DialogTitle, FormControl, FormControlLabel, InputLabel, MenuItem,
  Paper, Select, Stack, TextField, Typography,
} from '@mui/material';

const STATUSES = [
  { value: 0, label: 'Inactive (0)' },
  { value: 1, label: 'Standard subscriber (1)' },
  { value: 2, label: 'Premium subscriber (2)' },
  { value: 8, label: 'Moderator (8)' },
  { value: 9, label: 'Administrator (9)' },
];

const dateLabel = (value) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
};

export default function User({ user, packages = [], open, onClose, onSave, saving, currentUserStatus }) {
  const [draft, setDraft] = useState(null);
  const [filter, setFilter] = useState('');
  const { setError } = useFeedback();

  useEffect(() => {
    if (!open || !user) return;
    setDraft({
      id: Number(user.id),
      login: user.login || '',
      billing_id: String(user.billing_id ?? 0),
      status: Number(user.status),
      max_dev: Number(user.max_dev || 1),
      info: user.info || '',
      balance: String(user.balance ?? '0.00'),
      package_ids: (user.package_ids || []).map(Number),
    });
    setFilter('');
    setError('');
  }, [user, open, setError]);

  const visiblePackages = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return [...packages]
      .sort((a, b) => Number(a.position || 0) - Number(b.position || 0) || Number(a.id) - Number(b.id))
      .filter(pkg => !q || String(pkg.name || '').toLowerCase().includes(q) || String(pkg.code || '').toLowerCase().includes(q));
  }, [packages, filter]);

  const togglePackage = (id, checked) => setDraft(prev => ({
    ...prev,
    package_ids: checked
      ? [...prev.package_ids, id]
      : prev.package_ids.filter(value => value !== id),
  }));

  const save = async () => {
    if (!draft) return;
    if (!draft.login.trim() || draft.login.trim().length > 15) {
      setError('Login must contain 1–15 characters.');
      return;
    }
    if (!Number.isInteger(Number(draft.max_dev)) || Number(draft.max_dev) < 1 || Number(draft.max_dev) > 1000) {
      setError('Max devices must be between 1 and 1000.');
      return;
    }
    if (!/^-?(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,2})?$/.test(String(draft.balance).trim())) {
      setError('Balance must be a valid amount with up to 2 decimal places.');
      return;
    }
    if (draft.info.length > 10000) {
      setError('Info must not exceed 10000 characters.');
      return;
    }

    const billingID = String(draft.billing_id ?? '').trim() || '0';
    const maxBillingID = '18446744073709551615';

    if (
      !/^(0|[1-9][0-9]*)$/.test(billingID) ||
      billingID.length > maxBillingID.length ||
      (
        billingID.length === maxBillingID.length &&
        billingID > maxBillingID
      )
    ) {
      setError('Billing ID must be a valid unsigned integer.');
      return;
    }  

    setError('');
    try {
      await onSave({
        ...draft,
        login: draft.login.trim(),
        max_dev: Number(draft.max_dev),
        info: draft.info,
        balance: String(draft.balance).trim(),
        package_ids: draft.package_ids,
        billing_id: billingID,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={Boolean(open)} onClose={saving ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>Edit user{user ? ` #${user.id}` : ''}</DialogTitle>
      <DialogContent dividers>
        {draft && (
          <Stack spacing={2} sx={{ pt: 1 }}>
            



            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
            >
              <TextField
                label="Login (phone number)"
                size="small"
                fullWidth
                required
                value={draft.login}
                onChange={e =>
                  setDraft(p => ({
                    ...p,
                    login: e.target.value,
                  }))
                }
              />

              <TextField
                label="Billing ID"
                size="small"
                fullWidth
                value={draft.billing_id}
                disabled={Number(currentUserStatus) !== 9}
                inputProps={{
                  inputMode: 'numeric',
                  pattern: '[0-9]*',
                }}
                onChange={e => {
                  const value = e.target.value;

                  if (/^[0-9]*$/.test(value)) {
                    setDraft(p => ({
                      ...p,
                      billing_id: value,
                    }));
                  }
                }}
              />

              <TextField
                label="Balance"
                size="small"
                fullWidth
                value={draft.balance}
                disabled={Number(currentUserStatus) !== 9}
                helperText={
                  Number(currentUserStatus) === 9
                    ? 'Signed amount, e.g. -15.75'
                    : 'Only administrators can change the balance'
                }
                onChange={e =>
                  setDraft(p => ({
                    ...p,
                    balance: e.target.value,
                  }))
                }
              />
            </Stack>



            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <FormControl size="small" fullWidth>
                <InputLabel id="user-status-label">Status</InputLabel>
                <Select labelId="user-status-label" label="Status" value={draft.status}
                  disabled={Number(currentUserStatus) !== 9}
                  onChange={e => setDraft(p => ({ ...p, status: Number(e.target.value) }))}>
                  {STATUSES.map(item => <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>)}
                </Select>
              </FormControl>
              <TextField label="Max devices" type="number" fullWidth size="small"
                inputProps={{ min: 1, max: 1000, step: 1 }}
                value={draft.max_dev} onChange={e => setDraft(p => ({ ...p, max_dev: e.target.value }))} />
            </Stack>
            <TextField
              label="Info"
              size="small"
              fullWidth
              multiline
              minRows={2}
              value={draft.info}
              onChange={e => setDraft(p => ({ ...p, info: e.target.value }))}
              helperText="Address, notes and other subscriber information"
            />
            <Typography variant="subtitle1" fontWeight={600}>
              Packages ({draft.package_ids.length} assigned)
            </Typography>
            <TextField size="small" placeholder="Search packages by name or code"
              value={filter} onChange={e => setFilter(e.target.value)} />
            <Paper variant="outlined" sx={{ maxHeight: 300, overflowY: 'auto', p: 1 }}>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, gap: 0.5 }}>
                {visiblePackages.map(pkg => (
                  <FormControlLabel key={pkg.id} sx={{ mx: 0, minWidth: 0 }}
                    control={<Checkbox size="small" checked={draft.package_ids.includes(Number(pkg.id))}
                      onChange={e => togglePackage(Number(pkg.id), e.target.checked)} />}
                    label={<Typography variant="body2" noWrap title={pkg.name}>
                      {pkg.name} {Number(pkg.enabled) === 0 ? '(disabled)' : ''}
                    </Typography>} />
                ))}
              </Box>
              {!visiblePackages.length && <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
                No packages found.
              </Typography>}
            </Paper>
            <Typography color="text.secondary" variant="caption">
              Package assignments are stored for future access rules. They do not yet restrict playlists or streams.
            </Typography>
            {user && <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1 }}>
              <Typography variant="body2" color="text.secondary">Last login: {dateLabel(user.login_at)}</Typography>
              <Typography variant="body2" color="text.secondary">Last active: {dateLabel(user.last_active)}</Typography>
              <Typography variant="body2" color="text.secondary">Last IP: {user.last_ip || '—'}</Typography>
              <Typography variant="body2" color="text.secondary">Created: {dateLabel(user.created_at)}</Typography>
            </Box>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving || !draft}>
          {saving ? 'Saving...' : 'Save user'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
