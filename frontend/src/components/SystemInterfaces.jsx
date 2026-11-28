
import React from 'react';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';

import LanOutlinedIcon from '@mui/icons-material/LanOutlined';

import useSystemMonitor from '../hooks/useSystemMonitor';

const formatTraffic = (value) => {
  if (value == null) return '—';

  const mbps = Number(value) * 8 / 1000000;

  return `${mbps.toFixed(2)} Mbps`;
};

const formatLinkSpeed = (value) => {
  const speed = Number(value);

  if (!Number.isFinite(speed) || speed <= 0) {
    return '—';
  }

  if (speed >= 1000) {
    return `${speed / 1000} Gbps`;
  }

  return `${speed} Mbps`;
};

const formatBytes = (value) => {
  if (value == null) return '—';

  let size = Number(value);

  const units = [
    'B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB',
  ];

  let index = 0;

  while (
    size >= 1024 &&
    index < units.length - 1
  ) {
    size /= 1024;
    index++;
  }

  return `${size.toFixed(2)} ${units[index]}`;
};

const getInterfaceLoad = (bytesPerSec, speed) => {
  if (
    bytesPerSec == null ||
    !Number.isFinite(Number(speed)) ||
    speed <= 0
  ) {
    return null;
  }

  return Number(bytesPerSec) * 8 /
    (Number(speed) * 1000000) * 100;
};

function InterfaceLoad({
  label,
  value,
  color = 'primary',
}) {
  return (
    <Box sx={{ minWidth: 100 }}>
      <Typography
        variant="caption"
        sx={{
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {label}: {
          value == null
            ? '—'
            : `${value.toFixed(1)}%`
        }
      </Typography>

      {value != null && (
        <LinearProgress
          variant="determinate"
          value={Math.min(100, Math.max(0, value))}
          color={
            value >= 90
              ? 'error'
              : value >= 75
                ? 'warning'
                : color
          }
          sx={{
            mt: 0.5,
            height: 5,
            borderRadius: 1,
          }}
        />
      )}
    </Box>
  );
}

export default function SystemInterfaces() {
  const { data, loading, error } =
    useSystemMonitor('adminSystemInterfaces');

  const interfaces = data?.interfaces || [];

  return (
    <Box>
      <Stack
        direction="row"
        spacing={2}
        sx={{
          mb: 3,
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Typography
          variant="body2"
          color="text.secondary"
        >
          Monitor network interfaces and traffic.
        </Typography>

        {data && (
          <Typography
            variant="caption"
            color={error ? 'error.main' : 'text.secondary'}
          >
            Updated: {
              new Date(
                data.updated_at * 1000,
              ).toLocaleTimeString()
            }
          </Typography>
        )}
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading && !data ? (
        <Box sx={{ textAlign: 'center', py: 5 }}>
          <CircularProgress />
        </Box>
      ) : data && (
        <TableContainer
          component={Paper}
          variant="outlined"
        >
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Interface</TableCell>
                <TableCell>Addresses</TableCell>
                <TableCell>State</TableCell>
                <TableCell>MTU</TableCell>
                <TableCell>Link speed</TableCell>
                <TableCell>Traffic</TableCell>
                <TableCell>I/O load</TableCell>
                <TableCell>Total traffic</TableCell>
                <TableCell>Errors / dropped</TableCell>
              </TableRow>
            </TableHead>

            <TableBody>
              {interfaces.map((item) => (
                <TableRow key={item.name} hover>
                  <TableCell>
                    <Stack
                      direction="row"
                      spacing={1}
                      sx={{ alignItems: 'center' }}
                    >
                      <LanOutlinedIcon
                        fontSize="small"
                        color="action"
                      />

                      <Box>
                        <Typography
                          variant="body2"
                          fontWeight={600}
                        >
                          {item.name}
                        </Typography>

                        <Typography
                          variant="caption"
                          color="text.secondary"
                          sx={{ fontFamily: 'monospace' }}
                        >
                          {item.mac || '—'}
                        </Typography>
                      </Box>
                    </Stack>
                  </TableCell>

                  <TableCell>
                    {(item.addresses || []).map(
                      (address) => (
                        <Typography
                          key={address}
                          variant="body2"
                          sx={{
                            fontFamily: 'monospace',
                            fontSize: 12,
                          }}
                        >
                          {address}
                        </Typography>
                      ),
                    )}

                    {!item.addresses?.length && '—'}
                  </TableCell>

                  <TableCell>
                    <Chip
                      size="small"
                      variant="outlined"
                      label={
                        (item.state || 'unknown')
                          .toUpperCase()
                      }
                      color={
                        item.state === 'up'
                          ? 'success'
                          : item.state === 'down'
                            ? 'error'
                            : 'default'
                      }
                    />
                  </TableCell>

                  <TableCell>{item.mtu}</TableCell>

                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {formatLinkSpeed(item.speed)}
                  </TableCell>

                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <Typography
                      variant="body2"
                      color="primary.main"
                      sx={{ fontSize: 12 }}
                    >
                      RX: {formatTraffic(item.rx_bytes_per_sec)}
                    </Typography>

                    <Typography
                      variant="body2"
                      color="success.main"
                      sx={{ fontSize: 12 }}
                    >
                      TX: {formatTraffic(item.tx_bytes_per_sec)}
                    </Typography>
                  </TableCell>

                  <TableCell>
                    <Stack spacing={1}>
                      <InterfaceLoad
                        label="RX"
                        value={getInterfaceLoad(
                          item.rx_bytes_per_sec,
                          item.speed,
                        )}
                      />

                      <InterfaceLoad
                        label="TX"
                        color="success"
                        value={getInterfaceLoad(
                          item.tx_bytes_per_sec,
                          item.speed,
                        )}
                      />
                    </Stack>
                  </TableCell>

                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <Tooltip
                      title={`RX packets: ${item.rx_packets}`}
                    >
                      <Typography
                        variant="body2"
                        sx={{ fontSize: 12 }}
                      >
                        RX: {formatBytes(item.rx_bytes)}
                      </Typography>
                    </Tooltip>

                    <Tooltip
                      title={`TX packets: ${item.tx_packets}`}
                    >
                      <Typography
                        variant="body2"
                        sx={{ fontSize: 12 }}
                      >
                        TX: {formatBytes(item.tx_bytes)}
                      </Typography>
                    </Tooltip>
                  </TableCell>

                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <Typography
                      variant="body2"
                      color={
                        item.rx_errors || item.rx_dropped
                          ? 'error.main'
                          : 'text.secondary'
                      }
                      sx={{ fontSize: 12 }}
                    >
                      RX: {item.rx_errors} / {item.rx_dropped}
                    </Typography>

                    <Typography
                      variant="body2"
                      color={
                        item.tx_errors || item.tx_dropped
                          ? 'error.main'
                          : 'text.secondary'
                      }
                      sx={{ fontSize: 12 }}
                    >
                      TX: {item.tx_errors} / {item.tx_dropped}
                    </Typography>
                  </TableCell>
                </TableRow>
              ))}

              {interfaces.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={9}
                    align="center"
                    sx={{ py: 6 }}
                  >
                    <Typography color="text.secondary">
                      No network interfaces found.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}
