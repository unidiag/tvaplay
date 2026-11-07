import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent,
  DialogTitle, FormControlLabel, InputAdornment, Paper, Stack, Switch,
  TextField, Typography,
} from '@mui/material';
import { Search } from '@mui/icons-material';

const EMPTY_PACKAGE = {
  id: 0, name: '', code: '', description: '', monthly_price: '0.00',
  position: 0, enabled: 1, optional: false, for_new: false, channel_ids: [],
};

const transliterate = value => {
  const map = {
    а:'a', б:'b', в:'v', г:'g', д:'d', е:'e', ё:'yo', ж:'zh', з:'z', и:'i', й:'y',
    к:'k', л:'l', м:'m', н:'n', о:'o', п:'p', р:'r', с:'s', т:'t', у:'u', ф:'f',
    х:'h', ц:'ts', ч:'ch', ш:'sh', щ:'sch', ъ:'', ы:'y', ь:'', э:'e', ю:'yu', я:'ya',
    і:'i', ў:'u', ї:'yi', є:'ye', ґ:'g',
  };
  return String(value || '').toLowerCase().split('')
    .map(char => map[char] !== undefined ? map[char] : char).join('')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').substring(0, 64);
};

export default function PackageModal({ open, pkg, channels = [], onClose, onSave, saving = false }) {
  const [draft, setDraft] = useState(EMPTY_PACKAGE);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setDraft({
      ...EMPTY_PACKAGE,
      ...(pkg || {}),
      monthly_price: String(pkg?.monthly_price ?? '0.00'),
      optional: Boolean(pkg?.optional),
      for_new: Boolean(pkg?.for_new),
      channel_ids: (pkg?.channel_ids || []).map(Number),
    });
    setQuery('');
    setError('');
  }, [open, pkg]);

  const sortedChannels = useMemo(() => [...channels].sort((a, b) =>
    Number(a.position || 0) - Number(b.position || 0) || Number(a.id) - Number(b.id)), [channels]);

  const filteredChannels = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortedChannels.filter(channel =>
      !q || String(channel.id).includes(q) || String(channel.name || '').toLowerCase().includes(q));
  }, [query, sortedChannels]);

  const toggleChannel = (id, checked) => setDraft(prev => ({
    ...prev,
    channel_ids: checked
      ? [...new Set([...prev.channel_ids, id])]
      : prev.channel_ids.filter(value => value !== id),
  }));

  const selectVisible = checked => setDraft(prev => {
    const ids = new Set(prev.channel_ids);
    filteredChannels.forEach(channel => checked ? ids.add(channel.id) : ids.delete(channel.id));
    return { ...prev, channel_ids: [...ids] };
  });

  const save = async () => {
    const name = draft.name.trim();
    const code = draft.code.trim().toLowerCase();
    if (!name) { setError('Package name is required.'); return; }
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(code)) {
      setError('Code must use lowercase letters, digits, dash or underscore.');
      return;
    }
    if (!/^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$/.test(String(draft.monthly_price).trim())) {
      setError('Monthly price must be a non-negative amount with up to 2 decimal places.');
      return;
    }
    setError('');
    try {
      await onSave({
        id: draft.id, name, code, description: draft.description,
        monthly_price: String(draft.monthly_price).trim(),
        position: Number(draft.position), enabled: draft.enabled ? 1 : 0,
        optional: Boolean(draft.optional),
        for_new: Boolean(draft.for_new),
        channel_ids: draft.channel_ids.map(Number),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog open={Boolean(open)} onClose={saving ? undefined : onClose} fullWidth maxWidth="md">
      <DialogTitle>{draft.id ? 'Edit package' : 'New package'}</DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField label="Name" required fullWidth value={draft.name} onChange={e => {
            const name = e.target.value;
            setDraft(prev => ({
              ...prev, name,
              code: !prev.code || prev.code === transliterate(prev.name)
                ? transliterate(name) : prev.code,
            }));
          }} />
          <TextField label="Code" required fullWidth
            helperText="Unique lowercase identifier (e.g. basic, premium_hd)"
            value={draft.code}
            onChange={e => setDraft(p => ({ ...p, code: e.target.value.toLowerCase() }))} />
          <TextField label="Description" fullWidth multiline minRows={2}
            value={draft.description || ''}
            onChange={e => setDraft(p => ({ ...p, description: e.target.value }))} />

          <Stack direction="row" spacing={2} alignItems="center">
            <TextField label="Monthly price" type="number" size="small"
              value={draft.monthly_price}
              onChange={e => setDraft(p => ({ ...p, monthly_price: e.target.value }))}
              inputProps={{ min: 0, max: 99999999.99, step: '0.01' }}
              sx={{ width: 180 }} />
            <Stack direction="row" spacing={2} alignItems="center"
              sx={{ marginLeft: 'auto !important' }}>
              <TextField label="Position" type="number" size="small"
                value={draft.position}
                onChange={e => setDraft(p => ({ ...p, position: e.target.value }))}
                inputProps={{ min: 0, max: 65535 }} sx={{ width: 140 }} />
              <FormControlLabel
                control={<Switch checked={Boolean(draft.optional)}
                  onChange={e => setDraft(p => ({ ...p, optional: e.target.checked }))} />}
                label="Optional" sx={{ mr: 0 }} />
              <FormControlLabel
                control={<Switch checked={Boolean(draft.for_new)}
                  onChange={e => setDraft(p => ({ ...p, for_new: e.target.checked }))} />}
                label="For new" sx={{ mr: 0 }} />
              <FormControlLabel
                control={<Switch checked={Boolean(draft.enabled)}
                  onChange={e => setDraft(p => ({ ...p, enabled: e.target.checked ? 1 : 0 }))} />}
                label="Enabled" sx={{ mr: 0 }} />
            </Stack>
          </Stack>

          <Typography variant="subtitle1" fontWeight={600}>
            Channels ({draft.channel_ids.length} selected)
          </Typography>
          <TextField size="small" placeholder="Search by channel name or ID"
            value={query} onChange={e => setQuery(e.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> }} />
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Typography variant="caption" color="text.secondary">{filteredChannels.length} channels shown</Typography>
            <Stack direction="row" spacing={1}>
              <Button size="small" onClick={() => selectVisible(true)}>Select shown</Button>
              <Button size="small" onClick={() => selectVisible(false)}>Clear shown</Button>
            </Stack>
          </Box>
          <Paper variant="outlined" sx={{ maxHeight: 360, overflowY: 'auto', p: 1 }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: 'repeat(3, minmax(0, 1fr))' }, columnGap: 1 }}>
              {filteredChannels.map(channel => (
                <FormControlLabel key={channel.id} sx={{ mx: 0, minWidth: 0 }}
                  control={<Checkbox size="small"
                    checked={draft.channel_ids.includes(Number(channel.id))}
                    onChange={e => toggleChannel(Number(channel.id), e.target.checked)} />}
                  label={<Typography variant="body2">{channel.name}{' '}
                    <Typography component="span" variant="caption" color="text.secondary">#{channel.id}</Typography>
                  </Typography>} />
              ))}
            </Box>
            {!filteredChannels.length && (
              <Typography color="text.secondary" variant="body2" sx={{ p: 2 }}>No matching channels.</Typography>
            )}
          </Paper>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={save} variant="contained" disabled={saving}>
          {saving ? 'Saving...' : 'Save package'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
