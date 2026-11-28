
const COLORS = [
  '#2563eb',
  '#16a34a',
  '#f59e0b',
  '#dc2626',
  '#9333ea',
  '#0891b2',
  '#ea580c',
  '#4f46e5',
  '#65a30d',
  '#db2777',
];

const PERIODS = {
  '1': 'Today',
  '7': 'Last 7 days',
  '30': 'Last 30 days',
  all: 'All time',
};

const VIEW_TYPES = {
  all: 'Live + Archive',
  live: 'Live',
  archive: 'Archive',
};



const formatHours = seconds =>
  (Number(seconds || 0) / 3600).toLocaleString('ru-RU', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

function fitText(ctx, value, maxWidth) {
  let text = String(value || '');

  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }

  while (
    text.length > 0 &&
    ctx.measureText(`${text}…`).width > maxWidth
  ) {
    text = text.slice(0, -1);
  }

  return `${text}…`;
}

function drawReport(canvas, channels, period, viewType) {
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Canvas is not available');
  }

  const W = canvas.width;
  const H = canvas.height;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Header
  ctx.fillStyle = '#2563eb';
  ctx.fillRect(0, 0, W, 14);

  ctx.fillStyle = '#111827';
  ctx.font = 'bold 48px Arial, sans-serif';
  ctx.fillText('TVAPLAY', 80, 110);

  ctx.font = 'bold 36px Arial, sans-serif';
  ctx.fillText('Channel Popularity Report', 80, 175);

  ctx.fillStyle = '#64748b';
  ctx.font = '24px Arial, sans-serif';

  ctx.fillText(
    `${PERIODS[period] || period}  |  ${VIEW_TYPES[viewType] || viewType}`,
    80,
    225
  );

  ctx.fillText(
    `Generated: ${new Date().toLocaleString('ru-RU')}`,
    80,
    265
  );

  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(80, 300);
  ctx.lineTo(W - 80, 300);
  ctx.stroke();

  const totalDuration = channels.reduce(
    (sum, channel) => sum + channel.duration,
    0
  );

  // Doughnut chart
  const cx = W / 2;
  const cy = 660;
  const outerRadius = 285;
  const innerRadius = 175;

  let startAngle = -Math.PI / 2;

  channels.forEach((channel, index) => {
    const angle =
      channel.duration / totalDuration * Math.PI * 2;

    const endAngle = startAngle + angle;

    ctx.beginPath();
    ctx.arc(
      cx, cy, outerRadius,
      startAngle, endAngle, false
    );
    ctx.arc(
      cx, cy, innerRadius,
      endAngle, startAngle, true
    );
    ctx.closePath();

    ctx.fillStyle = COLORS[index];
    ctx.fill();

    startAngle = endAngle;
  });

  // Doughnut center
  ctx.textAlign = 'center';

  ctx.fillStyle = '#64748b';
  ctx.font = '24px Arial, sans-serif';
  ctx.fillText('TOP 10 WATCH TIME', cx, cy - 25);

  ctx.fillStyle = '#111827';
  ctx.font = 'bold 43px Arial, sans-serif';
  ctx.fillText(
    `${formatHours(totalDuration)} h`,
    cx,
    cy + 35
  );

  ctx.textAlign = 'left';

  // Table header
  const tableTop = 1050;

  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(80, tableTop, W - 160, 55);

  ctx.fillStyle = '#475569';
  ctx.font = 'bold 22px Arial, sans-serif';
  ctx.fillText('CHANNEL', 110, tableTop + 36);

  ctx.textAlign = 'right';
  ctx.fillText('HOURS', 965, tableTop + 36);
  ctx.fillText('SHARE', 1130, tableTop + 36);
  ctx.textAlign = 'left';

  // TOP 10
  channels.forEach((channel, index) => {
    const y = tableTop + 95 + index * 54;

    const percentage =
      channel.duration / totalDuration * 100;

    // Channel color
    ctx.fillStyle = COLORS[index];
    ctx.fillRect(110, y - 20, 18, 18);

    // Rank and name
    ctx.fillStyle = '#111827';
    ctx.font = '21px Arial, sans-serif';

    const name = fitText(
      ctx,
      `${index + 1}. ${channel.name}`,
      650
    );

    ctx.fillText(name, 145, y);

    // Duration and percentage
    ctx.textAlign = 'right';

    ctx.fillText(
      formatHours(channel.duration),
      965,
      y
    );

    ctx.fillText(
      `${percentage.toFixed(1)}%`,
      1130,
      y
    );

    ctx.textAlign = 'left';

    // Row divider
    ctx.strokeStyle = '#edf2f7';
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(110, y + 16);
    ctx.lineTo(1130, y + 16);
    ctx.stroke();
  });

  // Footer
  ctx.fillStyle = '#64748b';
  ctx.font = '20px Arial, sans-serif';

  ctx.fillText(
    'Popularity is calculated by total watch time.',
    80,
    H - 100
  );

  ctx.fillText(
    'Shares are relative to the selected TOP 10 channels.',
    80,
    H - 65
  );

  ctx.textAlign = 'right';
  ctx.fillText('TVAPLAY', W - 80, H - 65);
  ctx.textAlign = 'left';
}

export async function openStatisticsPdf({
  channels = [],
  period = '7',
  viewType = 'all',
}) {
  // Открываем вкладку синхронно, пока браузер
  // обрабатывает пользовательский клик.
  const tab = window.open('', '_blank');

  if (!tab) {
    throw new Error(
      'Browser blocked the PDF popup. Allow popups for this site.'
    );
  }

  try {
    tab.document.title = 'TVAPLAY PDF Report';

    const top10 = channels
      .map(channel => ({
        name: String(channel.channel_name || ''),
        duration: Number(channel.duration_sec || 0),
      }))
      .filter(channel =>
        Number.isFinite(channel.duration) &&
        channel.duration > 0
      )
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);

    if (top10.length === 0) {
      throw new Error('No viewing statistics available');
    }

    const canvas = document.createElement('canvas');

    // A4 portrait, high-resolution raster.
    canvas.width = 1240;
    canvas.height = 1754;

    drawReport(canvas, top10, period, viewType);

    // Загружаем библиотеку только при создании отчёта.
    const { jsPDF } = await import('jspdf');

    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    pdf.addImage(
      canvas.toDataURL('image/png'),
      'PNG',
      0,
      0,
      210,
      297
    );

    const blob = pdf.output('blob');
    const url = URL.createObjectURL(blob);

    tab.location.replace(url);

    // Даём встроенному PDF-просмотрщику время
    // открыть документ.
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 300000);
  } catch (err) {
    tab.close();
    throw err;
  }
}
