import useFeedback from '../hooks/useFeedback';
import React, { useEffect, useState } from 'react';
import {
  Box, Button, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Typography,
} from '@mui/material';

export default function StorageSmart({ open, storage, request, onClose }) {
  const [loading, setLoading] = useState(false);
  const { error, setError } = useFeedback();
  const [device, setDevice] = useState('');
  const [attributes, setAttributes] = useState([]);

  useEffect(() => {
    if (!open || !storage) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    setDevice('');
    setAttributes([]);

    request('adminStorageSmart', { id: storage.id })
      .then((response) => {
        if (cancelled) return;
        if (response.status && response.status !== 'OK') {
          throw new Error(response.message || 'Cannot load SMART attributes.');
        }
        setDevice(String(response.device || ''));
        setAttributes(Array.isArray(response.attributes) ? response.attributes : []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [open, storage, request, setError]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>SMART — {storage?.name || 'Storage'}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {device || storage?.path || ''}
        </Typography>

        {loading && (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress size={28} />
          </Box>
        )}

        

        {!loading && !error && (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>ATTRIBUTE_NAME</TableCell>
                  <TableCell>RAW_VALUE</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {attributes.map((attribute, index) => (
                  <TableRow key={`${attribute.attribute_name}-${index}`} hover>
                    <TableCell>{attribute.attribute_name}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>
                      {attribute.raw_value}
                    </TableCell>
                  </TableRow>
                ))}
                {attributes.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={2} align="center">No SMART attributes available.</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DialogContent>
      <DialogActions>
        <Button size="small" onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
