
import React, { useEffect, useState } from 'react';
import {
  Box,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';

import { apiRequest } from '../utils/api';
import useFeedback from '../hooks/useFeedback';

const TOKEN_KEY = 'tvaplay_access_token';

const formatNumber = value =>
  Number(value || 0).toLocaleString('ru-RU');

const formatDuration = seconds =>
  (Number(seconds || 0) / 3600).toLocaleString('ru-RU', {
    maximumFractionDigits: 1,
  });

export default function StatProgramModal({
  open,
  onClose,
  channel,
  period = '7',
  viewType = 'all',
}) {
  const { setError } = useFeedback();

  const [programmes, setProgrammes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setLocalError] = useState('');

  const channelID = channel?.channel_id;

  useEffect(() => {
    if (!open || !channelID) return;

    let cancelled = false;

    const loadProgrammes = async () => {
      setLoading(true);
      setLocalError('');
      setProgrammes([]);

      try {
        const response = await apiRequest(
          'adminProgrammeStatistics',
          {
            channel_id: channelID,
            period,
            view_type: viewType,
          },
          localStorage.getItem(TOKEN_KEY) || null
        );

        if (!cancelled) {
          setProgrammes(response.programmes || []);
        }
      } catch (err) {
        if (!cancelled) {
          const message =
            err.message || 'Cannot load programme statistics';

          setLocalError(message);
          setError(message);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadProgrammes();

    return () => {
      cancelled = true;
    };
  }, [open, channelID, period, viewType, setError]);

  const maxDuration = Math.max(
    1,
    ...programmes.map(item => Number(item.duration_sec || 0))
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="lg"
      scroll="paper"
    >
      <DialogTitle sx={{ pr: 7 }}>
        <Typography
          variant="h6"
          component="div"
          fontWeight={700}
        >
          {channel?.channel_name || 'Channel'}
        </Typography>

        <Typography
          variant="body2"
          color="text.secondary"
        >
          Programme popularity by watch time
        </Typography>

        <IconButton
          aria-label="Close"
          onClick={onClose}
          sx={{
            position: 'absolute',
            right: 12,
            top: 12,
          }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        {loading ? (
          <Box
            sx={{
              display: 'flex',
              justifyContent: 'center',
              py: 6,
            }}
          >
            <CircularProgress size={30} />
          </Box>
        ) : error ? (
          <Typography
            color="error"
            textAlign="center"
            sx={{ py: 4 }}
          >
            {error}
          </Typography>
        ) : programmes.length === 0 ? (
          <Typography
            color="text.secondary"
            textAlign="center"
            sx={{ py: 5 }}
          >
            No programme statistics available.
          </Typography>
        ) : (
          <TableContainer>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell width={60}>#</TableCell>
                  <TableCell>Programme</TableCell>
                  <TableCell align="right">Views</TableCell>
                  <TableCell align="right">Viewers</TableCell>
                  <TableCell align="right">Live</TableCell>
                  <TableCell align="right">Archive</TableCell>
                  <TableCell align="right">Hours</TableCell>
                  <TableCell width={150}>
                    Popularity
                  </TableCell>
                </TableRow>
              </TableHead>

              <TableBody>
                {programmes.map((programme, index) => {
                  const popularity =
                    Number(programme.duration_sec || 0) /
                    maxDuration * 100;

                  return (
                    <TableRow
                      key={`${programme.title}-${index}`}
                      hover
                    >
                      <TableCell>
                        {index + 1}
                      </TableCell>

                      <TableCell>
                        <Typography
                          variant="body2"
                          fontWeight={500}
                        >
                          {programme.title}
                        </Typography>
                      </TableCell>

                      <TableCell align="right">
                        {formatNumber(programme.views)}
                      </TableCell>

                      <TableCell align="right">
                        {formatNumber(programme.unique_viewers)}
                      </TableCell>

                      <TableCell align="right">
                        {formatNumber(programme.live_views)}
                      </TableCell>

                      <TableCell align="right">
                        {formatNumber(programme.archive_views)}
                      </TableCell>

                      <TableCell align="right">
                        {formatDuration(programme.duration_sec)}
                      </TableCell>

                      <TableCell>
                        <Tooltip
                          title={`${popularity.toFixed(1)}%`}
                        >
                          <LinearProgress
                            variant="determinate"
                            value={popularity}
                            sx={{
                              height: 8,
                              borderRadius: 1,
                            }}
                          />
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DialogContent>
    </Dialog>
  );
}
