import React from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
} from '@mui/material';

export default function StorageModal({
  open,
  editingID,
  draft,
  error,
  saving,
  onChange,
  onClose,
  onSave,
}) {
  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>{editingID === null ? 'Add storage' : 'Edit storage'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ mt: 1 }}>
          <TextField
            label="Name"
            size="small"
            fullWidth
            autoFocus
            value={draft.name}
            onChange={(event) => onChange('name', event.target.value)}
            placeholder="Archive HDD 1"
            disabled={saving}
          />
          <TextField
            label="Mount path"
            size="small"
            fullWidth
            value={draft.path}
            onChange={(event) => onChange('path', event.target.value)}
            placeholder="/mnt/sda"
            helperText="Absolute directory path used for archive recordings."
            InputProps={{ sx: { fontFamily: 'monospace' } }}
            disabled={saving}
          />
          <FormControlLabel
            control={
              <Switch
                checked={draft.enabled}
                onChange={(event) => onChange('enabled', event.target.checked)}
                disabled={saving}
              />
            }
            label="Enable storage"
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button size="small" disabled={saving} onClick={onClose}>Cancel</Button>
        <Button size="small" variant="contained" disabled={saving} onClick={onSave}>
          {saving ? 'Saving...' : editingID === null ? 'Create' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
