
import React, {
  useCallback,
  useEffect,
  useState,
} from 'react';
import {
  Box,
  Button,
  ButtonBase,
  CircularProgress,
  FormControl,
  InputLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { apiRequest } from '../utils/api';
import useFeedback from '../hooks/useFeedback';
import StatProgramModal from '../components/StatProgramModal';
import PictureAsPdfIcon from '@mui/icons-material/PictureAsPdf';
import { openStatisticsPdf } from '../utils/statisticsPdf';

const TOKEN_KEY = 'tvaplay_access_token';

const formatNumber = value =>
  Number(value || 0).toLocaleString('ru-RU');

const formatDuration = seconds =>
  (Number(seconds || 0) / 3600).toLocaleString('ru-RU', {
    maximumFractionDigits: 1,
  });

function SummaryCard({ title, value }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, flex: 1, minWidth: 150 }}>
      <Typography variant="body2" color="text.secondary">
        {title}
      </Typography>
      <Typography variant="h5" fontWeight={700} sx={{ mt: 1 }}>
        {value}
      </Typography>
    </Paper>
  );
}

export default function Statistics() {
  const { setError } = useFeedback();

  const [period, setPeriod] = useState('7');
  const [viewType, setViewType] = useState('all');
  const [loading, setLoading] = useState(true);
  const [selectedChannel, setSelectedChannel] = useState(null);

  const [data, setData] = useState({
    channels: [],
    total_views: 0,
    total_viewers: 0,
    total_duration_sec: 0,
  });

    const handlePdfReport = async () => {
    try {
        await openStatisticsPdf({
        channels: data.channels,
        period,
        viewType,
        });
    } catch (err) {
        setError(err.message || 'Cannot generate PDF report');
    }
    };


  const loadStatistics = useCallback(async (signal) => {
    setLoading(true);

    try {
      const response = await apiRequest(
        'adminStatistics',
        { period, view_type: viewType },
        localStorage.getItem(TOKEN_KEY) || null
      );

      if (signal?.aborted) return;

      setData({
        channels: response.channels || [],
        total_views: Number(response.total_views || 0),
        total_viewers: Number(response.total_viewers || 0),
        total_duration_sec: Number(response.total_duration_sec || 0),
      });
    } catch (err) {
      if (!signal?.aborted) {
        setError(err.message || 'Cannot load statistics');
      }
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [period, viewType, setError]);

  useEffect(() => {
    const controller = new AbortController();
    loadStatistics(controller.signal);

    return () => controller.abort();
  }, [loadStatistics]);

  const channels = data.channels;

    const maxDuration = Math.max(
    1,
    ...channels.map(item => Number(item.duration_sec || 0))
    );

  return (
    <Box>



        <Stack
        direction={{ xs: 'column', md: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', md: 'center' }}
        spacing={2}
        sx={{ mb: 3 }}
        >
        <Box>
            <Typography variant="h5" fontWeight={700}>
            Statistics
            </Typography>
            <Typography variant="body2" color="text.secondary">
            Channel popularity and viewing activity.
            </Typography>
        </Box>

        <Stack
        direction="row"
        spacing={1}
        useFlexGap
        flexWrap="wrap"
        sx={{
            ml: { md: 'auto !important' },
            justifyContent: 'flex-end',
        }}
        >
            <FormControl size="small" sx={{ minWidth: 125 }}>
            <InputLabel>Period</InputLabel>
            <Select
                value={period}
                label="Period"
                onChange={e => setPeriod(e.target.value)}
            >
                <MenuItem value="1">Today</MenuItem>
                <MenuItem value="7">7 days</MenuItem>
                <MenuItem value="30">30 days</MenuItem>
                <MenuItem value="all">All time</MenuItem>
            </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 130 }}>
            <InputLabel>View type</InputLabel>
            <Select
                value={viewType}
                label="View type"
                onChange={e => setViewType(e.target.value)}
            >
                <MenuItem value="all">All views</MenuItem>
                <MenuItem value="live">Live</MenuItem>
                <MenuItem value="archive">Archive</MenuItem>
            </Select>
            </FormControl>

            <Button
            variant="outlined"
            color="primary"
            size="medium"
            startIcon={<PictureAsPdfIcon />}
            onClick={handlePdfReport}
            disabled={
                loading ||
                !data.channels.some(
                channel => Number(channel.duration_sec || 0) > 0
                )
            }
            sx={{
                whiteSpace: 'nowrap',
                height: 40,
                textTransform: 'none',
            }}
            >
            PDF Report
            </Button>

        </Stack>
        </Stack>



      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        sx={{ mb: 3 }}
      >
        <SummaryCard
          title="Total views"
          value={formatNumber(data.total_views)}
        />
        <SummaryCard
          title="Unique viewers"
          value={formatNumber(data.total_viewers)}
        />
        <SummaryCard
          title="Watch time (hours)"
          value={formatDuration(data.total_duration_sec)}
        />
      </Stack>

      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell width={60}>#</TableCell>
              <TableCell>Channel</TableCell>
              <TableCell align="right">Views</TableCell>
              <TableCell align="right">Viewers</TableCell>
              <TableCell align="right">Live</TableCell>
              <TableCell align="right">Archive</TableCell>
              <TableCell align="right">Hours</TableCell>
              <TableCell width={170}>Popularity</TableCell>
            </TableRow>
          </TableHead>

          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ py: 5 }}>
                  <CircularProgress size={28} />
                </TableCell>
              </TableRow>
            ) : channels.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                  No statistics available.
                </TableCell>
              </TableRow>
            ) : (
              channels.map((channel, index) => (
                <TableRow key={channel.channel_id} hover>
                  <TableCell>{index + 1}</TableCell>


                    <TableCell>
                    <ButtonBase
                        onClick={() => setSelectedChannel(channel)}
                        sx={{
                        color: 'primary.main',
                        textAlign: 'left',
                        fontSize: '0.875rem',
                        fontWeight: 500,
                        borderRadius: 0.5,
                        '&:hover': {
                            textDecoration: 'underline',
                        },
                        }}
                    >
                        {channel.channel_name}
                    </ButtonBase>
                    </TableCell>


                  <TableCell align="right">
                    {formatNumber(channel.views)}
                  </TableCell>

                  <TableCell align="right">
                    {formatNumber(channel.unique_viewers)}
                  </TableCell>

                  <TableCell align="right">
                    {formatNumber(channel.live_views)}
                  </TableCell>

                  <TableCell align="right">
                    {formatNumber(channel.archive_views)}
                  </TableCell>

                  <TableCell align="right">
                    {formatDuration(channel.duration_sec)}
                  </TableCell>

                  <TableCell>
                        <LinearProgress
                        variant="determinate"
                        value={
                            Number(channel.duration_sec || 0) /
                            maxDuration * 100
                        }
                        />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </TableContainer>


<StatProgramModal
  open={Boolean(selectedChannel)}
  onClose={() => setSelectedChannel(null)}
  channel={selectedChannel}
  period={period}
  viewType={viewType}
/>


    </Box>
  );
}
