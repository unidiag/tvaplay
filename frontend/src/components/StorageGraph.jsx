import useFeedback from '../hooks/useFeedback';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Box, Button, CircularProgress, Dialog, DialogActions,
  DialogContent, DialogTitle, Stack, ToggleButton, ToggleButtonGroup,
  Typography,
} from '@mui/material';

const MIB = 1024 * 1024;
const TB = 1e12;
const PLOT = { left: 64, top: 16, right: 18, bottom: 40 };
const WIDTH = 860;
const HEIGHT = 230;
const INNER_W = WIDTH - PLOT.left - PLOT.right;
const INNER_H = HEIGHT - PLOT.top - PLOT.bottom;

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const shortTime = (timestamp, hours) => new Date(timestamp).toLocaleString(
  undefined,
  hours === 24
    ? { hour: '2-digit', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: '2-digit' }
);

// For a 7-day view, reduce ~10,080 minute samples to 672 15-minute
// aggregates. This preserves trend and avoids rendering huge SVG paths.
// Keep null buckets absent: do not manufacture measurements for outages.
function aggregateMetrics(rows, hours) {
  const widthMs = (hours === 24 ? 3 : 15) * 60 * 1000;
  const buckets = new Map();

  rows.forEach((row) => {
    const time = new Date(row.minute).getTime();
    if (!Number.isFinite(time)) return;
    const key = Math.floor(time / widthMs) * widthMs;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { time: key, count: 0, read: 0, write: 0, util: 0, used: 0, total: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    bucket.read += number(row.read_bytes_per_sec) / MIB;
    bucket.write += number(row.write_bytes_per_sec) / MIB;
    bucket.util += number(row.util_percent);
    bucket.used += number(row.size_used_bytes) / TB;
    bucket.total += number(row.size_total_bytes) / TB;
  });

  return Array.from(buckets.values())
    .sort((a, b) => a.time - b.time)
    .map((item) => ({
      time: item.time,
      read: item.read / item.count,
      write: item.write / item.count,
      util: item.util / item.count,
      used: item.used / item.count,
      total: item.total / item.count,
    }));
}

// SVG tooltip follows the pointer and stays within the graph viewport.
function ChartTooltip({ hover, hours, rows }) {
  if (!hover) return null;

  const tooltipWidth = 194;
  const tooltipHeight = 26 + rows.length * 20 + 10;
  const left = Math.max(8, Math.min(WIDTH - tooltipWidth - 8, hover.x + 14));
  const top = Math.max(8, Math.min(HEIGHT - tooltipHeight - 8, hover.y + 12));

  return (
    <g transform={`translate(${left}, ${top})`} pointerEvents="none">
      <rect
        width={tooltipWidth}
        height={tooltipHeight}
        rx="6"
        fill="#20252e"
        stroke="#48515f"
        strokeWidth="1"
        opacity="0.97"
      />
      <text x="12" y="19" fill="#ffffff" fontSize="12" fontWeight="600">
        {shortTime(hover.point.time, hours)}
      </text>
      {rows.map((row, index) => (
        <g key={row.label} transform={`translate(0, ${29 + index * 20})`}>
          <circle cx="15" cy="5" r="4" fill={row.color} />
          <text x="26" y="9" fill="#e7ebf2" fontSize="12">{row.label}</text>
          <text x={tooltipWidth - 12} y="9" textAnchor="end" fill="#ffffff" fontSize="12" fontWeight="600">
            {row.value}
          </text>
        </g>
      ))}
    </g>
  );
}

// Legend marker and label share one flex line and vertical center.
function LegendItem({ label, color }) {
  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, whiteSpace: 'nowrap' }}>
      <Box
        component="span"
        sx={{
          display: 'block',
          width: 10,
          height: 10,
          flex: '0 0 10px',
          borderRadius: '50%',
          bgcolor: color,
        }}
      />
      <Typography component="span" variant="caption" sx={{ display: 'block', lineHeight: 1 }}>
        {label}
      </Typography>
    </Box>
  );
}

function LineChart({ title, points, hours, series, unit, fixedMax, useCompactRange }) {
  const [hover, setHover] = useState(null);
  const end = Date.now();
  const start = end - hours * 3600000;
  const valid = points.filter((point) => point.time >= start && point.time <= end);
  const values = valid.flatMap((point) => series.map((item) => number(point[item.key])));
  const maxValue = Math.max(0, ...values);
  const minValue = values.length ? Math.min(...values) : 0;
  const yMin = useCompactRange && values.length
    ? Math.max(0, minValue - Math.max((maxValue - minValue) * 0.2, maxValue * 0.005))
    : 0;
  const yMax = fixedMax || Math.max(
    yMin + (useCompactRange ? 0.001 : 0.1),
    useCompactRange ? maxValue + Math.max((maxValue - minValue) * 0.2, maxValue * 0.005) : maxValue * 1.12
  );
  const x = (time) => PLOT.left + (time - start) * INNER_W / (end - start);
  const y = (value) => PLOT.top + INNER_H - (value - yMin) * INNER_H / (yMax - yMin);

  // An interruption of > 2 expected bucket periods means missing data.
  const expectedMs = (hours === 24 ? 3 : 15) * 60000;
  const paths = series.map((line) => {
    let previous = null;
    const commands = valid.map((point) => {
      const cmd = !previous || point.time - previous.time > expectedMs * 2.2 ? 'M' : 'L';
      previous = point;
      return `${cmd}${x(point.time).toFixed(2)},${y(number(point[line.key])).toFixed(2)}`;
    });
    return { ...line, path: commands.join(' ') };
  });

  const onMove = (event) => {
    if (!valid.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const localX = (event.clientX - rect.left) * WIDTH / rect.width;
    const desired = start + (localX - PLOT.left) * (end - start) / INNER_W;
    let closest = valid[0];
    let best = Math.abs(closest.time - desired);
    for (let i = 1; i < valid.length; i++) {
      const distance = Math.abs(valid[i].time - desired);
      if (distance < best) { closest = valid[i]; best = distance; }
    }
    const localY = (event.clientY - rect.top) * HEIGHT / rect.height;
    setHover({ point: closest, x: localX, y: localY });
  };

  return (
    <Box sx={{ mb: 3 }}>
      <Stack
        direction="row"
        alignItems="center"
        sx={{
          width: '100%',
          mb: 1,
          gap: 2,
        }}
      >
        <Typography variant="subtitle1" fontWeight={600}>
          {title}
        </Typography>

        <Box sx={{ ml: 'auto', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2 }}>
          {series.map((item) => (
            <LegendItem key={item.key} label={item.label} color={item.color} />
          ))}
        </Box>
      </Stack>
      {valid.length === 0 ? (
        <Typography color="text.secondary" variant="body2" sx={{ py: 5, textAlign: 'center' }}>
          No measurements available for this period.
        </Typography>
      ) : (
        <>
          <Box sx={{ width: '100%', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              width="100%"
              role="img"
              aria-label={`${title} history for the last ${hours} hours`}
              style={{ display: 'block', touchAction: 'pan-y' }}
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
            >
              {Array.from({ length: 5 }, (_, i) => {
                const value = yMin + (yMax - yMin) * i / 4;
                const cy = y(value);
                return (
                  <g key={i}>
                    <line x1={PLOT.left} x2={WIDTH - PLOT.right} y1={cy} y2={cy} stroke="currentColor" strokeOpacity="0.12" />
                    <text x={PLOT.left - 9} y={cy + 4} textAnchor="end" fontSize="12" fill="currentColor" opacity="0.7">
                      {unit === '%' ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2)}
                    </text>
                  </g>
                );
              })}
              {Array.from({ length: 5 }, (_, i) => {
                const timestamp = start + (end - start) * i / 4;
                const px = x(timestamp);
                return (
                  <text key={i} x={px} y={HEIGHT - 13} fontSize="12" textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'} fill="currentColor" opacity="0.7">
                    {shortTime(timestamp, hours)}
                  </text>
                );
              })}
              {paths.map((line) => (
                <path key={line.key} d={line.path} fill="none" stroke={line.color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {hover && (
                <g pointerEvents="none">
                  <line x1={x(hover.point.time)} x2={x(hover.point.time)} y1={PLOT.top} y2={PLOT.top + INNER_H} stroke="currentColor" strokeOpacity="0.55" strokeDasharray="4 4" />
                  {series.map((line) => (
                    <circle key={line.key} cx={x(hover.point.time)} cy={y(number(hover.point[line.key]))} r="4" fill={line.color} stroke="currentColor" strokeWidth="0.5" />
                  ))}
                </g>
              )}
              <rect x={PLOT.left} y={PLOT.top} width={INNER_W} height={INNER_H} fill="transparent" />
              <ChartTooltip
                hover={hover}
                hours={hours}
                rows={series.map((line) => ({
                  label: line.label,
                  color: line.color,
                  value: `${number(hover?.point?.[line.key]).toFixed(2)} ${unit}`,
                }))}
              />
            </svg>
          </Box>
        </>
      )}
    </Box>
  );
}

// Two Y axes: utilization on the left (0–100%), used space on the right (TB).
function LoadAndSpaceChart({ points, hours }) {
  const [hover, setHover] = useState(null);
  const end = Date.now();
  const start = end - hours * 3600000;
  const plot = { left: 64, right: 78, top: 16, bottom: 40 };
  const innerW = WIDTH - plot.left - plot.right;
  const innerH = HEIGHT - plot.top - plot.bottom;
  const valid = points.filter((point) => point.time >= start && point.time <= end);

  const usedValues = valid.map((point) => number(point.used));
  const usedMin = usedValues.length ? Math.min(...usedValues) : 0;
  const usedMax = usedValues.length ? Math.max(...usedValues) : 0;
  // Zoom the TB axis to expose small changes in used space.
  const padding = Math.max((usedMax - usedMin) * 0.2, usedMax * 0.005, 0.001);
  const tbMin = Math.max(0, usedMin - padding);
  const tbMax = Math.max(tbMin + 0.001, usedMax + padding);

  const x = (time) => plot.left + (time - start) * innerW / (end - start);
  const yUtil = (value) => plot.top + innerH * (1 - Math.min(100, Math.max(0, value)) / 100);
  const yUsed = (value) => plot.top + innerH * (1 - (value - tbMin) / (tbMax - tbMin));
  const expectedMs = (hours === 24 ? 3 : 15) * 60000;

  const makePath = (key, yScale) => {
    let previous = null;
    return valid.map((point) => {
      const command = previous === null || point.time - previous > expectedMs * 2.2 ? 'M' : 'L';
      previous = point.time;
      return `${command}${x(point.time).toFixed(2)},${yScale(number(point[key])).toFixed(2)}`;
    }).join(' ');
  };

  const onMove = (event) => {
    if (!valid.length) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width) return;
    const localX = (event.clientX - rect.left) * WIDTH / rect.width;
    const desired = start + (localX - plot.left) * (end - start) / innerW;
    let closest = valid[0];
    let best = Math.abs(closest.time - desired);
    for (let i = 1; i < valid.length; i++) {
      const distance = Math.abs(valid[i].time - desired);
      if (distance < best) {
        closest = valid[i];
        best = distance;
      }
    }
    const localY = (event.clientY - rect.top) * HEIGHT / rect.height;
    setHover({ point: closest, x: localX, y: localY });
  };

  return (
    <Box sx={{ mb: 3 }}>
      <Stack
        direction="row"
        alignItems="center"
        sx={{ width: '100%', mb: 1 }}
      >
        <Typography variant="subtitle1" fontWeight={600}>
          I/O Load / Used storage space
        </Typography>

        <Box sx={{ ml: 'auto', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2 }}>
          <LegendItem label="I/O load (%)" color="#ab47bc" />
          <LegendItem label="Used (TB)" color="#26a69a" />
        </Box>
      </Stack>
      {valid.length === 0 ? (
        <Typography color="text.secondary" variant="body2" sx={{ py: 5, textAlign: 'center' }}>
          No measurements available for this period.
        </Typography>
      ) : (
        <>
          <Box sx={{ width: '100%', border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden' }}>
            <svg
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              width="100%"
              role="img"
              aria-label={`I/O utilization and used storage space for the last ${hours} hours`}
              style={{ display: 'block', touchAction: 'pan-y' }}
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
            >
              {Array.from({ length: 5 }, (_, i) => {
                const percent = i * 25;
                const cy = yUtil(percent);
                const tb = tbMin + (tbMax - tbMin) * i / 4;
                return (
                  <g key={i}>
                    <line x1={plot.left} x2={WIDTH - plot.right} y1={cy} y2={cy} stroke="currentColor" strokeOpacity="0.12" />
                    <text x={plot.left - 9} y={cy + 4} textAnchor="end" fontSize="12" fill="#ab47bc">
                      {percent}%
                    </text>
                    <text x={WIDTH - plot.right + 9} y={cy + 4} textAnchor="start" fontSize="12" fill="#26a69a">
                      {tb.toFixed(2)} TB
                    </text>
                  </g>
                );
              })}
              {Array.from({ length: 5 }, (_, i) => {
                const timestamp = start + (end - start) * i / 4;
                return (
                  <text
                    key={i}
                    x={x(timestamp)} y={HEIGHT - 13} fontSize="12"
                    textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}
                    fill="currentColor" opacity="0.7"
                  >
                    {shortTime(timestamp, hours)}
                  </text>
                );
              })}
              <path d={makePath('util', yUtil)} fill="none" stroke="#ab47bc" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
              <path d={makePath('used', yUsed)} fill="none" stroke="#26a69a" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
              {hover && (
                <g pointerEvents="none">
                  <line x1={x(hover.point.time)} x2={x(hover.point.time)} y1={plot.top} y2={plot.top + innerH} stroke="currentColor" strokeOpacity="0.55" strokeDasharray="4 4" />
                  <circle cx={x(hover.point.time)} cy={yUtil(number(hover.point.util))} r="4" fill="#ab47bc" />
                  <circle cx={x(hover.point.time)} cy={yUsed(number(hover.point.used))} r="4" fill="#26a69a" />
                </g>
              )}
              <rect x={plot.left} y={plot.top} width={innerW} height={innerH} fill="transparent" />
              <ChartTooltip
                hover={hover}
                hours={hours}
                rows={[
                  { label: 'I/O load', color: '#ab47bc', value: `${number(hover?.point?.util).toFixed(1)} %` },
                  { label: 'Used', color: '#26a69a', value: `${number(hover?.point?.used).toFixed(3)} TB` },
                ]}
              />
            </svg>
          </Box>
        </>
      )}
    </Box>
  );
}

export default function StorageGraph({ open, storage, request, onClose }) {
  const [hours, setHours] = useState(24);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const { error, setError } = useFeedback();
  const storageID = storage?.id;

  useEffect(() => {
    if (!open || storageID == null) return undefined;
    let active = true;
    setLoading(true);
    setError('');
    setRows([]);

    request('adminStorageMetrics', { id: storageID, hours })
      .then((response) => {
        if (!active) return;
        if (response.status && response.status !== 'OK') {
          throw new Error(response.message || 'Cannot load storage metrics.');
        }
        setRows(Array.isArray(response.metrics) ? response.metrics : []);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => { active = false; };
  }, [open, storageID, request, hours, setError]);

  const points = useMemo(() => aggregateMetrics(rows, hours), [rows, hours]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="lg" scroll="paper">
    <DialogTitle sx={{ px: 3, py: 1.5 }}>
      <Stack
        direction="row"
        alignItems="center"
        sx={{
          width: '100%',
          gap: 2,
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h6" fontWeight={700} noWrap>
            Storage history — {storage?.name || ''}
          </Typography>

          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block' }}
            noWrap
          >
            {storage?.path || ''}
          </Typography>
        </Box>

        <ToggleButtonGroup
          exclusive
          size="small"
          value={hours}
          onChange={(_, next) => {
            if (next !== null) setHours(next);
          }}
          sx={{
            ml: 'auto !important',
            flexShrink: 0,
            '& .MuiToggleButton-root': {
              height: 26,
              px: 1,
              py: 0,
              fontSize: '0.7rem',
              lineHeight: 1,
              textTransform: 'none',
              whiteSpace: 'nowrap',
            },
          }}
        >
          <ToggleButton value={24}>24 hours</ToggleButton>
          <ToggleButton value={168}>7 days</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
    </DialogTitle>
      <DialogContent dividers>
        {loading ? (
          <Box sx={{ py: 10, textAlign: 'center' }}><CircularProgress /></Box>
        ) : error ? null : (
          <>
            <LineChart
              title="Read / write speed" points={points} hours={hours} unit="MiB/s"
              series={[
                { key: 'read', label: 'Read', color: '#42a5f5' },
                { key: 'write', label: 'Write', color: '#ff9800' },
              ]}
            />
            <LoadAndSpaceChart points={points} hours={hours} />
          </>
        )}
      </DialogContent>
      <DialogActions><Button size="small" onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}
