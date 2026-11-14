import useFeedback from '../hooks/useFeedback';
import React, { useEffect, useState } from 'react';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { AccountBalanceWalletOutlined, RefreshOutlined } from '@mui/icons-material';

const errorText = err => err instanceof Error ? err.message : String(err);

const TYPE_LABELS = {
  balance_topup: 'Пополнение',
  adjustment: 'Корректировка',
  balance_set: 'Установка баланса',
  set: 'Установка баланса',
  daily_charge: 'Абонентская плата',
  subscription: 'Абонентская плата',
  pause_fee: 'Постановка на паузу',
  pause_refund: 'Возврат стоимости паузы',
  resume_fee: 'Возобновление вещания',
  package_charge: 'Плата за пакет',
};

function transactionName(type) {
  const key = String(type || '');
  return TYPE_LABELS[key] || key || 'Неизвестная операция';
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// Все денежные поля приходят строками DECIMAL; не используем float.
function formatAmount(value) {
  const text = String(value ?? '').trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return { text: text || '—', sign: 0 };
  const cents = (match[3] || '').padEnd(2, '0');
  const zero = /^0+$/.test(match[2]) && cents === '00';
  const sign = zero ? 0 : match[1] === '-' ? -1 : 1;
  return {
    text: `${sign < 0 ? '−' : sign > 0 ? '+' : ''}${match[2]}.${cents}`,
    sign,
  };
}

export default function Balance({ open, user, request, onClose }) {
  const [transactions, setTransactions] = useState([]);
  const [balance, setBalance] = useState(null);
  const [loading, setLoading] = useState(false);
  const { error, setError } = useFeedback();
  const [refreshKey, setRefreshKey] = useState(0);
  const userID = user?.id ?? null;

  useEffect(() => {
    if (!open || userID == null) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    setTransactions([]);
    setBalance(null);

    Promise.resolve()
      .then(() => request('adminUserBalanceTransactions', { id: String(userID) }))
      .then(data => {
        if (cancelled) return;
        if (!Array.isArray(data?.transactions)) {
          throw new Error('Некорректный ответ API: отсутствует transactions');
        }
        setTransactions(data.transactions);
        setBalance(data.balance == null ? null : String(data.balance));
      })
      .catch(err => {
        if (!cancelled) setError(errorText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [open, userID, request, refreshKey, setError]);

  const displayedBalance = balance ?? String(user?.balance ?? '—');

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth scroll="paper">
      <DialogTitle sx={{ pb: 1.5 }}>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <AccountBalanceWalletOutlined color="primary" />
          <Typography component="span" variant="h6">Детализация баланса</Typography>
          <Chip size="small" variant="outlined" label={`${displayedBalance} руб.`} />
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {user?.login || ''} · User ID: {userID ?? '—'}
          {user?.billing_id ? ` · Billing ID: ${user.billing_id}` : ''}
        </Typography>
      </DialogTitle>

      <DialogContent dividers sx={{ px: { xs: 1, sm: 2 }, py: 1.5 }}>
        
        {loading ? (
          <Box sx={{ py: 6, textAlign: 'center' }}><CircularProgress /></Box>
        ) : (
          <>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
              Последние {transactions.length} операций (максимум 100), новые сверху
            </Typography>
            <TableContainer sx={{ maxHeight: '65vh' }}>
              <Table size="small" stickyHeader sx={{
                '& .MuiTableCell-root': {
                  py: 0.55, px: 1.2, fontSize: '0.8rem', lineHeight: 1.35,
                },
              }}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>Дата и время</TableCell>
                    <TableCell>Операция</TableCell>
                    <TableCell align="right">Сумма</TableCell>
                    <TableCell align="right">Баланс после</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {transactions.map((item, index) => {
                    const amount = formatAmount(item.amount);
                    return (
                      <TableRow key={item.id ?? index} hover>
                        <TableCell sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                          {formatDate(item.created_at)}
                        </TableCell>
                        <TableCell title={String(item.type || '')}>
                          {transactionName(item.type)}
                        </TableCell>
                        <TableCell align="right" sx={{
                          whiteSpace: 'nowrap', fontWeight: 700,
                          color: amount.sign < 0 ? 'error.main' : amount.sign > 0 ? 'success.main' : 'text.primary',
                          fontVariantNumeric: 'tabular-nums',
                        }}>
                          {amount.text}
                        </TableCell>
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                          {item.balance_after == null ? '—' : String(item.balance_after)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!transactions.length && !error && (
                    <TableRow>
                      <TableCell colSpan={4} align="center" sx={{ py: 4 }}>
                        Нет операций по балансу.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 2, py: 1 }}>
        <Button startIcon={<RefreshOutlined />} disabled={loading} onClick={() => setRefreshKey(n => n + 1)}>
          Обновить
        </Button>
        <Button onClick={onClose}>Закрыть</Button>
      </DialogActions>
    </Dialog>
  );
}
