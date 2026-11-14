import useFeedback from '../hooks/useFeedback';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {
  Button,
  Box,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';

import { EditOutlined, Search } from '@mui/icons-material';
import MovieFilterIcon from '@mui/icons-material/MovieFilter';
import StatsModal from '../components/StatsModal';
import { apiRequest } from '../utils/api';
import User from '../components/UserModal';
import Sessions from '../components/UserSessions';
import Balance from '../components/Balance';

const TOKEN_KEY = 'tvaplay_access_token';
const ROWS_PER_PAGE = 50;

const errorText = err =>
  err instanceof Error ? err.message : String(err);

function statusName(value) {
  switch (Number(value)) {
    case 0: return 'Inactive';
    case 1: return 'Standard';
    case 2: return 'Premium';
    case 8: return 'Moderator (8)';
    case 9: return 'Admin (9)';
    default: return `Status ${value}`;
  }
}

// Billing ID отображаем строкой, чтобы не терять
// точность при больших числовых идентификаторах.
function billingIDText(value) {
  if (value == null || String(value) === '0') {
    return '';
  }

  return String(value);
}

// Подсветка всех совпадений поисковой подстроки.
function Highlight({ value, query }) {
  const text = String(value ?? '');
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return text;
  }

  const source = text.toLowerCase();
  const parts = [];
  let position = 0;
  let index;
  let key = 0;

  while ((index = source.indexOf(needle, position)) !== -1) {
    if (index > position) {
      parts.push(text.substring(position, index));
    }

    parts.push(
      <Box
        component="mark"
        key={key++}
        sx={{
          backgroundColor: '#ffeb3b',
          color: '#212121',
          borderRadius: '2px',
          px: '1px',
          fontWeight: 600,
        }}
      >
        {text.substring(index, index + needle.length)}
      </Box>
    );

    position = index + needle.length;
  }

  if (position < text.length) {
    parts.push(text.substring(position));
  }

  return <>{parts}</>;
}

function compareValues(a, b, field) {
  if (field === 'id' ||
      field === 'status' ||
      field === 'max_dev' ||
      field === 'active_sessions' ||
      field === 'online' ||
      field === 'balance') {
    return Number(a[field] || 0) - Number(b[field] || 0);
  }

  const valueA = field === 'billing_id'
    ? billingIDText(a.billing_id)
    : String(a[field] ?? '');

  const valueB = field === 'billing_id'
    ? billingIDText(b.billing_id)
    : String(b[field] ?? '');

  // Числовая сортировка Billing ID без потери точности.
  if (field === 'billing_id') {
    const x = valueA.replace(/^0+/, '') || '0';
    const y = valueB.replace(/^0+/, '') || '0';

    if (x.length !== y.length) {
      return x.length - y.length;
    }

    return x < y ? -1 : x > y ? 1 : 0;
  }

  return valueA.localeCompare(valueB, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export default function Users() {
  const [users, setUsers] = useState([]);
  const [currentUserStatus, setCurrentUserStatus] = useState(null);
  const [packages, setPackages] = useState([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(null);
  const [viewingSessions, setViewingSessions] = useState(null);
  const [viewingBalance, setViewingBalance] = useState(null);
  const [viewingStats, setViewingStats] = useState(null);

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const [orderBy, setOrderBy] = useState('id');
  const [order, setOrder] = useState('desc');
  const { setError, setNotice } = useFeedback();

  const request = useCallback(
    (op, params = {}) =>
      apiRequest(
        op,
        params,
        localStorage.getItem(TOKEN_KEY) || null
      ),
    []
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');

    try {
      const [responseUsers, responsePackages] =
        await Promise.all([
          request('adminUsers'),
          request('adminPackages'),
        ]);

      setCurrentUserStatus(
        responseUsers.current_user_status == null
          ? null
          : Number(responseUsers.current_user_status)
      );

      setUsers((responseUsers.users || []).map(u => ({
        ...u,
        id: Number(u.id),
        billing_id: billingIDText(u.billing_id),
        status: Number(u.status),
        max_dev: Number(u.max_dev),
        active_sessions: Number(u.active_sessions ?? 0),
        online: Number(u.online ?? 0),
        info: u.info || '',
        balance: String(u.balance ?? '0.00'),
        package_ids: (u.package_ids || []).map(Number),
      })));

      setPackages((responsePackages.packages || []).map(p => ({
        ...p,
        id: Number(p.id),
        enabled: Number(p.enabled),
      })));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [request, setError]);

  useEffect(() => {
    reload();
  }, [reload]);

  const packageNames = useMemo(() => {
    const names = {};

    packages.forEach(pkg => {
      names[pkg.id] = pkg.name;
    });

    return names;
  }, [packages]);

  // Строки пакетов для отображения и сортировки.
  const preparedUsers = useMemo(() => {
    return users.map(user => ({
      ...user,
      packages_text: user.package_ids
        .map(id => packageNames[id] || `#${id}`)
        .join(', '),
    }));
  }, [users, packageNames]);

  // Поиск по внутреннему ID, логину и Billing ID.
  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();

    if (!q) {
      return preparedUsers;
    }

    return preparedUsers.filter(user =>
      String(user.id).includes(q) ||
      String(user.login || '').toLowerCase().includes(q) ||
      billingIDText(user.billing_id).toLowerCase().includes(q)
    );
  }, [preparedUsers, search]);

  // Сортировка всего результата поиска.
  const sortedUsers = useMemo(() => {
    return filteredUsers.slice().sort((a, b) => {
      const result = compareValues(a, b, orderBy);

      if (result !== 0) {
        return order === 'asc' ? result : -result;
      }

      // При равных значениях сохраняем порядок по ID.
      return b.id - a.id;
    });
  }, [filteredUsers, orderBy, order]);

  const maxPage = Math.max(
    0,
    Math.ceil(sortedUsers.length / ROWS_PER_PAGE) - 1
  );

  const currentPage = Math.min(page, maxPage);

  // Пагинация после поиска и сортировки.
  const visibleUsers = useMemo(() => {
    const start = currentPage * ROWS_PER_PAGE;

    return sortedUsers.slice(start, start + ROWS_PER_PAGE);
  }, [sortedUsers, currentPage]);

  const handleSearch = event => {
    setSearch(event.target.value);
    setPage(0);
  };

  const handleSort = field => {
    if (orderBy === field) {
      setOrder(previous =>
        previous === 'asc' ? 'desc' : 'asc'
      );
    } else {
      setOrderBy(field);
      setOrder('asc');
    }

    setPage(0);
  };

  const save = async draft => {
    setSaving(true);
    setError('');
    setNotice('');

    try {
      await request('adminUserSave', draft);
      await reload();

      setEditing(null);
      setNotice('User updated.');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const columns = [
    { id: 'id', label: 'ID' },
    { id: 'online', label: 'Online', align: 'center' },
    { id: 'login', label: 'Login' },
    { id: 'billing_id', label: 'Billing ID' },
    { id: 'status', label: 'Status' },
    { id: 'active_sessions', label: 'Devices', align: 'center' },
    { id: 'balance', label: 'Balance', align: 'right' },
    { id: 'info', label: 'Info' },
    { id: 'packages_text', label: 'Packages' },
  ];

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', sm: 'center' }}
        spacing={2}
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography variant="h5" fontWeight={700}>
            Users
          </Typography>

          <Typography variant="body2" color="text.secondary">
            Manage subscriber profiles and channel package assignments.
          </Typography>

          <Typography variant="caption" color="text.secondary">
            Total users: {users.length}
            {search.trim() && ` · Found: ${filteredUsers.length}`}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'flex-end', flex: 1 }}>
          <TextField
            size="small"
            placeholder="Search by ID, login or Billing ID"
            value={search}
            onChange={handleSearch}
            sx={{
              width: 320,
              maxWidth: '100%',
            }}
            InputProps={{
              startAdornment: (
                <Search
                  fontSize="small"
                  sx={{
                    mr: 1,
                    color: 'text.secondary',
                  }}
                />
              ),
            }}
          />
        </Box>
      </Stack>

      

      

      <Paper variant="outlined">
        {loading ? (
          <Box sx={{ p: 6, textAlign: 'center' }}>
            <CircularProgress />
          </Box>
        ) : (
          <>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    {columns.map(column => (
                      <TableCell
                        key={column.id}
                        align={column.align || 'left'}
                        sortDirection={
                          orderBy === column.id ? order : false
                        }
                        sx={{
                          whiteSpace: 'nowrap',
                          fontWeight: 700,
                        }}
                      >
                        <TableSortLabel
                          active={orderBy === column.id}
                          direction={
                            orderBy === column.id ? order : 'asc'
                          }
                          onClick={() => handleSort(column.id)}
                        >
                          {column.label}
                        </TableSortLabel>
                      </TableCell>
                    ))}

                    <TableCell align="right">
                      Actions
                    </TableCell>
                  </TableRow>
                </TableHead>

                <TableBody>
                  {visibleUsers.map(user => (
                    <TableRow key={user.id} hover>
                      <TableCell>
                        <Highlight
                          value={user.id}
                          query={search}
                        />
                      </TableCell>

                      <TableCell align="center">
                        {user.online > 0 ? (
                          <Chip
                            size="small"
                            color="success"
                            variant="filled"
                            label={user.online}
                          />
                        ) : null}
                      </TableCell>

                      <TableCell>
                        <Highlight
                          value={user.login}
                          query={search}
                        />
                      </TableCell>

                      <TableCell>
                        {user.billing_id ? (
                          <Highlight
                            value={user.billing_id}
                            query={search}
                          />
                        ) : (
                          '—'
                        )}
                      </TableCell>

                      <TableCell>
                        <Chip
                          size="small"
                          variant="outlined"
                          label={statusName(user.status)}
                          color={
                            [8, 9].includes(Number(user.status))
                              ? 'error'
                              : Number(user.status) === 2
                                ? 'success'
                                : Number(user.status) === 1
                                  ? 'primary'
                                  : 'default'
                          }
                        />
                      </TableCell>

                      <TableCell align="center">
                        <Tooltip title="View user sessions">
                          <Button
                            size="small"
                            variant="text"
                            color={user.active_sessions > user.max_dev ? 'warning' : 'primary'}
                            onClick={() => setViewingSessions(user)}
                            sx={{
                              minWidth: 65,
                              fontWeight: 700,
                              fontVariantNumeric: 'tabular-nums',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {user.active_sessions} / {user.max_dev}
                          </Button>
                        </Tooltip>
                      </TableCell>

                      <TableCell align="right">
                        <Tooltip title="View balance transactions">
                          <Button
                            size="small"
                            variant="text"
                            onClick={() => setViewingBalance(user)}
                            sx={{
                              minWidth: 0,
                              px: 0.75,
                              fontWeight: 700,
                              fontVariantNumeric: 'tabular-nums',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {user.balance}
                          </Button>
                        </Tooltip>
                      </TableCell>

                      <TableCell sx={{ maxWidth: 230 }}>
                        <Typography
                          variant="body2"
                          noWrap
                          title={user.info}
                        >
                          {user.info || '—'}
                        </Typography>
                      </TableCell>

                      <TableCell>
                        {user.packages_text || '—'}
                      </TableCell>

                      <TableCell align="right">
                        <Tooltip title="Viewing statistics">
                          <IconButton size="small" onClick={() => setViewingStats(user)}>
                            <MovieFilterIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Edit user">
                          <span>
                            <IconButton
                              size="small"
                              onClick={() => setEditing(user)}
                              disabled={saving}
                            >
                              <EditOutlined fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}

                  {!visibleUsers.length && (
                    <TableRow>
                      <TableCell
                        colSpan={10}
                        align="center"
                        sx={{ py: 5 }}
                      >
                        {users.length
                          ? 'No matching users.'
                          : 'No users found.'}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>

            <TablePagination
              component="div"
              count={sortedUsers.length}
              page={currentPage}
              onPageChange={(_, nextPage) => setPage(nextPage)}
              rowsPerPage={ROWS_PER_PAGE}
              rowsPerPageOptions={[ROWS_PER_PAGE]}
              labelRowsPerPage="Rows per page:"
              showFirstButton
              showLastButton
            />
          </>
        )}
      </Paper>

      <User
        open={Boolean(editing)}
        user={editing}
        packages={packages}
        saving={saving}
        currentUserStatus={currentUserStatus}
        onClose={() => setEditing(null)}
        onSave={save}
      />

      <Balance
        open={Boolean(viewingBalance)}
        user={viewingBalance}
        request={request}
        onClose={() => setViewingBalance(null)}
      />

      <StatsModal
        open={Boolean(viewingStats)}
        user={viewingStats}
        request={request}
        onClose={() => setViewingStats(null)}
      />

      <Sessions
        open={Boolean(viewingSessions)}
        user={viewingSessions}
        request={request}
        onClose={() => setViewingSessions(null)}
        onChanged={reload}
      />
    </Box>
  );
}
