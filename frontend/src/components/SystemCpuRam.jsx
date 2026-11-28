
import React from 'react';
import {
  Alert,
  Box,
  CircularProgress,
  LinearProgress,
  Paper,
  Stack,
  Typography,
} from '@mui/material';

import useSystemMonitor from '../hooks/useSystemMonitor';
import DeviceThermostatIcon from '@mui/icons-material/DeviceThermostat';

const formatMemory = (bytes) => {
  if (bytes == null) return '—';

  return `${(Number(bytes) / 1073741824).toFixed(2)} GiB`;
};

const formatPercent = (value) => {
  if (value == null) return '—';

  return `${Number(value).toFixed(1)}%`;
};

const formatUptime = (seconds) => {
  let value = Math.max(
    0,
    Math.floor(Number(seconds) || 0),
  );

  const days = Math.floor(value / 86400);
  value %= 86400;

  const hours = Math.floor(value / 3600);
  value %= 3600;

  const minutes = Math.floor(value / 60);

  return `${days}d ${hours}h ${minutes}m`;
};

const progressColor = (value) => {
  if (value >= 90) return 'error';
  if (value >= 75) return 'warning';

  return 'primary';
};

const temperatureColor = (value) => {
  if (value >= 85) return 'error.main';
  if (value >= 70) return 'warning.main';

  return 'success.main';
};


function UsageCard({
  title,
  percent,
  description,
  temperature = null,
}) {
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1.5}>

        <Stack
          direction="row"
          sx={{
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Typography
            variant="body2"
            color="text.secondary"
          >
            {title}
          </Typography>

          {temperature != null &&
            Number.isFinite(Number(temperature)) && (
              <Stack
                direction="row"
                spacing={0.25}
                sx={{
                  alignItems: 'center',
                  color: temperatureColor(temperature),
                }}
              >
                <DeviceThermostatIcon
                  sx={{ fontSize: 18 }}
                />

                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {Number(temperature).toFixed(1)}°C
                </Typography>
              </Stack>
            )}
        </Stack>

        <Typography variant="h4" fontWeight={600}>
          {formatPercent(percent)}
        </Typography>

        <LinearProgress
          variant={
            percent == null
              ? 'indeterminate'
              : 'determinate'
          }
          value={percent ?? 0}
          color={progressColor(percent)}
          sx={{
            height: 8,
            borderRadius: 1,
          }}
        />

        <Typography
          variant="caption"
          color="text.secondary"
        >
          {description}
        </Typography>

      </Stack>
    </Paper>
  );
}


export default function SystemCpuRam() {
  const { data, loading, error } =
    useSystemMonitor('adminSystemCPU');

  const cpu = data?.cpu;
  const memory = data?.memory;

  const swapPercent = memory?.swap_total > 0
    ? memory.swap_used / memory.swap_total * 100
    : 0;

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
          Monitor processor and memory utilization.
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

      {loading && !data && (
        <Box sx={{ textAlign: 'center', py: 5 }}>
          <CircularProgress />
        </Box>
      )}

      {data && (
        <Stack spacing={2}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: {
                xs: '1fr',
                sm: 'repeat(2, minmax(0, 1fr))',
                lg: 'repeat(4, minmax(0, 1fr))',
              },
              gap: 2,
            }}
          >
            <UsageCard
              title="CPU usage"
              percent={cpu.percent}
              temperature={cpu.temperature}
              description={
                `${cpu.model} · ${cpu.cores} logical cores`
              }
            />

            <UsageCard
              title="RAM usage"
              percent={memory.percent}
              description={
                `${formatMemory(memory.used)} / ${
                  formatMemory(memory.total)
                }`
              }
            />

            <UsageCard
              title="SWAP usage"
              percent={swapPercent}
              description={
                memory.swap_total > 0
                  ? `${formatMemory(memory.swap_used)} / ${
                      formatMemory(memory.swap_total)
                    }`
                  : 'SWAP is not configured'
              }
            />

            <Paper variant="outlined" sx={{ p: 2 }}>
              <Stack spacing={1.5}>
                <Typography
                  variant="body2"
                  color="text.secondary"
                >
                  Load average
                </Typography>

                <Stack
                  direction="row"
                  sx={{ justifyContent: 'space-between' }}
                >
                  {[1, 5, 15].map((minutes, index) => (
                    <Box key={minutes}>
                      <Typography
                        variant="h6"
                        fontWeight={600}
                      >
                        {
                          data.load_average?.[index]
                            ?.toFixed(2) ?? '—'
                        }
                      </Typography>

                      <Typography
                        variant="caption"
                        color="text.secondary"
                      >
                        {minutes} min
                      </Typography>
                    </Box>
                  ))}
                </Stack>

                <Typography
                  variant="caption"
                  color="text.secondary"
                >
                  Uptime: {formatUptime(data.uptime)}
                </Typography>
              </Stack>
            </Paper>
          </Box>

          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography
              variant="subtitle1"
              fontWeight={600}
              sx={{ mb: 2 }}
            >
              CPU cores
            </Typography>

            <Box
              sx={{
                display: 'grid',
                gridTemplateColumns: {
                  xs: '1fr',
                  sm: 'repeat(2, minmax(0, 1fr))',
                  lg: 'repeat(4, minmax(0, 1fr))',
                },
                gap: 2,
              }}
            >
              {(cpu.details || []).map((core) => (
                <Box key={core.name}>
                  <Stack
                    direction="row"
                    sx={{
                      justifyContent: 'space-between',
                      mb: 0.5,
                    }}
                  >
                    <Typography variant="body2">
                      {core.name.replace('cpu', 'CPU ')}
                    </Typography>

                    <Typography
                      variant="body2"
                      sx={{
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {formatPercent(core.percent)}
                    </Typography>
                  </Stack>

                  <LinearProgress
                    variant={
                      core.percent == null
                        ? 'indeterminate'
                        : 'determinate'
                    }
                    value={core.percent ?? 0}
                    color={progressColor(core.percent)}
                    sx={{
                      height: 6,
                      borderRadius: 1,
                    }}
                  />
                </Box>
              ))}
            </Box>
          </Paper>

          <Typography
            variant="caption"
            color="text.secondary"
          >
            Host: {data.hostname}
            {' · '}
            Refresh interval: {data.interval_seconds}s
          </Typography>
        </Stack>
      )}
    </Box>
  );
}
