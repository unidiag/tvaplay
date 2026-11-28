import React, { useState, useEffect, useCallback } from 'react';
import { apiRequest } from '../utils/api';
import useFeedback from '../hooks/useFeedback';
import {
  Alert, Autocomplete, Box, Button, Checkbox, Chip, CircularProgress,
  Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, TextField, Typography, TablePagination,
} from '@mui/material';
import { Add as AddIcon, MailOutlined as MailIcon } from '@mui/icons-material';

import MessageEditor, {
  sanitizeMessageHTML,
  messagePlainText,
  plainTextToHTML,
} from '../components/MessageEditor';


const TOKEN_KEY = 'tvaplay_access_token';
const initialForm = {
  id: 0,
  title: '',
  body: '',
  body_format: 'html',
  audience: 'individual',
  priority: 'normal',
  send_sms: false,
  sms_text: '',
  expires_at: null,
};
const columns = ['ID', 'Title', 'Audience', 'Priority', 'Recipients',
  'Delivered', 'Read', 'SMS', 'Status', 'Created', 'Actions'];
const errorText = err => err instanceof Error ? err.message : String(err);
const length = value => Array.from(value.trim()).length;
const userLabel = user => [user.login || `#${user.id}`,
  Number(user.billing_id) > 0 ? `Billing: ${user.billing_id}` : '',
  user.info || '',
].filter(Boolean).join(' · ');
const dateText = value => value ? new Date(value).toLocaleString() : '—';

export default function Messages() {
  const [messages, setMessages] = useState([]);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(50);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ ...initialForm });
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [userOptions, setUserOptions] = useState([]);
  const [userSearch, setUserSearch] = useState('');
  const [usersLoading, setUsersLoading] = useState(false);
  const [formError, setFormError] = useState('');
  const [confirm, setConfirm] = useState(null);
  const { setError, setNotice } = useFeedback();

  const request = useCallback((op, params = {}) =>
    apiRequest(op, params, localStorage.getItem(TOKEN_KEY) || null), []);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request('adminMessages');
      setMessages(data.messages || []);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [request, setError]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    if (!open || form.audience !== 'individual' || userSearch.trim().length < 2) {
      setUserOptions([]);
      setUsersLoading(false);
      return;
    }
    let active = true;
    setUserOptions([]);
    setUsersLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await request('adminMessageUsers', { search: userSearch.trim() });
        if (active) setUserOptions(data.users || []);
      } catch (err) {
        if (active) setError(errorText(err));
      } finally {
        if (active) setUsersLoading(false);
      }
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [open, form.audience, userSearch, request, setError]);

  const updateField = (field, value) => setForm(previous => ({ ...previous, [field]: value }));
  const resetSearch = () => { setUserOptions([]); setUserSearch(''); setFormError(''); };
  const handleAdd = () => {
    setForm({ ...initialForm });
    setSelectedUsers([]);
    resetSearch();
    setOpen(true);
  };
  const handleEdit = async id => {
    setBusy(true);
    try {
      const data = await request('adminMessageGet', { id });
      if (data.message?.status !== 'draft') throw new Error('Message is not a draft');
      const m = data.message;
      setForm({
        ...initialForm,
        ...m,

        body: m.body_format === 'html'
          ? sanitizeMessageHTML(m.body)
          : plainTextToHTML(m.body),

        body_format: 'html',

        sms_text: m.sms_text || '',
      });
      setSelectedUsers(data.users || []);
      resetSearch();
      setOpen(true);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };

  // Validate sanitized HTML and derive a plain-text SMS fallback.
  const cleanBody = sanitizeMessageHTML(form.body);
  const plainBody = messagePlainText(cleanBody);
  const imageNodes = new DOMParser().parseFromString(cleanBody, 'text/html')
    .querySelectorAll('img[src]');
  const hasImage = Array.from(imageNodes).some(img => {
    try {
      const url = new URL(img.getAttribute('src'));
      return url.protocol === 'https:' && Boolean(url.hostname) &&
        !url.username && !url.password;
    } catch {
      return false;
    }
  });
  const smsBody = form.sms_text.trim() || plainBody;
  const smsLength = length(smsBody);
  const canSave = !busy && length(form.title) > 0 && length(form.title) <= 255 &&
    (length(plainBody) > 0 || hasImage) && length(cleanBody) <= 10000 &&
    (!form.send_sms || (smsLength > 0 && smsLength <= 1000)) &&
    (form.audience === 'all' || selectedUsers.length > 0);

  const handleSave = async () => {
    if (!canSave) return;
    setBusy(true);
    setFormError('');
    try {
      await request('adminMessageSave', {
        id: form.id || 0, title: form.title.trim(), body: cleanBody,
        body_format: 'html',
        audience: form.audience, priority: form.priority, send_sms: Boolean(form.send_sms),
        sms_text: form.send_sms ? smsBody : '',
        user_ids: form.audience === 'individual' ? selectedUsers.map(u => Number(u.id)) : [],
        expires_at: form.expires_at || null,
      });
      setOpen(false);
      setNotice('Message draft saved.');
      await reload();
    } catch (err) { setFormError(errorText(err)); }
    finally { setBusy(false); }
  };

  const handleAction = async () => {
    if (!confirm || busy) return;
    const { action, message } = confirm;
    const operations = { publish: 'adminMessagePublish', delete: 'adminMessageDelete', cancel: 'adminMessageCancel' };
    setBusy(true);
    try {
      const data = await request(operations[action], { id: message.id });
      setConfirm(null);
      setNotice(action === 'publish' ? `Message published. Recipients: ${data.recipients ?? 0}` :
        action === 'delete' ? 'Draft deleted.' : 'Message cancelled.');
      await reload();
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };

  const filteredMessages = messages.filter(m =>
    String(m.title || '')
      .toLowerCase()
      .includes(search.trim().toLowerCase())
  );

  // Последняя доступная страница.
  const maxPage = Math.max(
    0,
    Math.ceil(filteredMessages.length / rowsPerPage) - 1
  );

  // Защита от выхода за пределы списка.
  const currentPage = Math.min(page, maxPage);

  // Сообщения текущей страницы.
  const paginatedMessages = filteredMessages.slice(
    currentPage * rowsPerPage,
    (currentPage + 1) * rowsPerPage
  );

  // При изменении количества сообщений корректируем страницу.
  useEffect(() => {
    if (page > maxPage) {
      setPage(maxPage);
    }
  }, [page, maxPage]);

  const handleChangePage = (_, newPage) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = event => {
    setRowsPerPage(Number(event.target.value));
    setPage(0);
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" sx={{ alignItems: 'center', justifyContent: 'space-between', gap: 2 }}>
        <Typography variant="h5">Message Center</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={handleAdd} disabled={busy}>Add message</Button>
      </Stack>
      <Stack direction="row" spacing={1}>
      <TextField
        size="small"
        placeholder="Search messages..."
        value={search}
        onChange={event => {
          setSearch(event.target.value);
          setPage(0);
        }}
        sx={{ maxWidth: 400, flex: 1 }}
      />
        <Button onClick={reload} disabled={loading || busy}>Refresh</Button>
      </Stack>
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead><TableRow>{columns.map(column => <TableCell key={column}>{column}</TableCell>)}</TableRow></TableHead>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={columns.length}>
                <Box sx={{ display: 'flex', justifyContent: 'center', py: 5 }}><CircularProgress size={28} /></Box>
              </TableCell></TableRow>
            ) : filteredMessages.length === 0 ? (
              <TableRow><TableCell colSpan={columns.length}>
                <Stack spacing={1} sx={{ alignItems: 'center', py: 5 }}>
                  <MailIcon sx={{ fontSize: 48, color: 'text.disabled' }} />
                  <Typography color="text.secondary">No messages</Typography>
                </Stack>
              </TableCell></TableRow>
            ) : paginatedMessages.map(message => (
              <TableRow key={message.id} hover>
                <TableCell>{message.id}</TableCell>
                <TableCell>{message.title}</TableCell>
                <TableCell>{message.audience}</TableCell>
                <TableCell>{message.priority}</TableCell>
                <TableCell>{message.recipients ?? 0}</TableCell>
                <TableCell>{message.delivered ?? 0}</TableCell>
                <TableCell>{message.read ?? 0}</TableCell>
                <TableCell>
                  {message.send_sms
                    ? [
                        `${message.sms_sent ?? 0} sent`,
                        `${message.sms_pending ?? 0} pending`,
                        `${message.sms_failed ?? 0} failed`,
                        `${message.sms_unknown ?? 0} unknown`,
                      ].join(' / ')
                    : '—'}
                </TableCell>
                <TableCell><Chip size="small" label={message.status} color={message.status === 'published' ? 'success' : 'default'} /></TableCell>
                <TableCell>{dateText(message.created_at)}</TableCell>
                <TableCell>
                  <Stack direction="row" spacing={1}>
                    {message.status === 'draft' && <>
                      <Button size="small" disabled={busy} onClick={() => handleEdit(message.id)}>Edit</Button>
                      <Button size="small" disabled={busy} onClick={() => setConfirm({ action: 'publish', message })}>Publish</Button>
                      <Button size="small" color="error" disabled={busy} onClick={() => setConfirm({ action: 'delete', message })}>Delete</Button>
                    </>}
                    {['published', 'scheduled'].includes(message.status) && (
                      <Button size="small" color="warning" disabled={busy} onClick={() => setConfirm({ action: 'cancel', message })}>Cancel</Button>
                    )}
                  </Stack>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <TablePagination
          component="div"
          count={filteredMessages.length}
          page={currentPage}
          rowsPerPage={rowsPerPage}
          rowsPerPageOptions={[10, 25, 50, 100]}
          onPageChange={handleChangePage}
          onRowsPerPageChange={handleChangeRowsPerPage}
          showFirstButton
          showLastButton
          labelRowsPerPage="Rows per page:"
        />

      </TableContainer>

      <Dialog open={open} onClose={() => { if (!busy) setOpen(false); }} fullWidth maxWidth="md">
        <DialogTitle>{form.id ? 'Edit message' : 'Add message'}</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {formError && <Alert severity="error">{formError}</Alert>}
            <TextField select fullWidth label="Audience" value={form.audience} disabled={busy}
              onChange={event => updateField('audience', event.target.value)}>
              <MenuItem value="all">All subscribers</MenuItem>
              <MenuItem value="individual">Selected subscribers</MenuItem>
            </TextField>
            {form.audience === 'individual' && (
              <Autocomplete multiple fullWidth options={userOptions} value={selectedUsers}
                loading={usersLoading} disabled={busy} filterSelectedOptions filterOptions={options => options}
                isOptionEqualToValue={(option, value) => Number(option.id) === Number(value.id)}
                getOptionLabel={userLabel} getOptionKey={option => option.id}
                onChange={(_, value) => setSelectedUsers(value)} inputValue={userSearch}
                onInputChange={(_, value) => setUserSearch(value)}
                noOptionsText={userSearch.trim().length < 2 ? 'Enter at least 2 characters' : 'No subscribers found'}
                renderInput={params => <TextField {...params} label="Subscribers" placeholder="Phone number or Billing ID" />}
              />
            )}
            <TextField fullWidth required label="Title" value={form.title} disabled={busy}
              onChange={event => updateField('title', event.target.value)}
              slotProps={{ htmlInput: { maxLength: 255 } }} />
            <MessageEditor
              value={form.body}
              disabled={busy}
              maxLength={10000}
              onChange={html => updateField('body', html)}
            />
            <TextField select fullWidth label="Priority" value={form.priority} disabled={busy}
              onChange={event => updateField('priority', event.target.value)}>
              <MenuItem value="normal">Normal</MenuItem>
              <MenuItem value="important">Important</MenuItem>
              <MenuItem value="critical">Critical</MenuItem>
            </TextField>
            <FormControlLabel label="Duplicate via SMS" control={<Checkbox checked={form.send_sms} disabled={busy}
              onChange={event => updateField('send_sms', event.target.checked)} />} />
            {form.send_sms && <TextField fullWidth multiline minRows={3} label="SMS text" value={form.sms_text} disabled={busy}
              onChange={event => updateField('sms_text', event.target.value)} error={smsLength === 0 || smsLength > 1000}
              helperText={smsLength === 0
                ? 'Enter SMS text (required for image-only messages).'
                : `Leave empty to use the plain text of the message. Characters: ${smsLength} / 1000`} />}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" disabled={!canSave} onClick={handleSave}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : null}>
            {busy ? 'Saving...' : 'Save draft'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(confirm)} onClose={() => { if (!busy) setConfirm(null); }} fullWidth maxWidth="xs">
        <DialogTitle>{confirm?.action === 'publish' ? 'Publish message?' : confirm?.action === 'delete' ? 'Delete draft?' : 'Cancel message?'}</DialogTitle>
        <DialogContent dividers>
          <Typography>{confirm?.message.title}</Typography>
          {confirm?.action === 'publish' && <Alert severity="warning" sx={{ mt: 2 }}>
            {confirm.message.audience === 'all' ? 'This message will be published to all subscribers.' : 'This message will be published to selected subscribers.'}
            {confirm.message.send_sms && ' SMS delivery will be queued.'}
          </Alert>}
          {confirm?.action === 'cancel' && <Typography color="text.secondary" sx={{ mt: 1 }}>Already sent SMS cannot be recalled.</Typography>}
        </DialogContent>
        <DialogActions>
          <Button disabled={busy} onClick={() => setConfirm(null)}>Back</Button>
          <Button variant="contained" disabled={busy} color={confirm?.action === 'delete' ? 'error' : 'primary'} onClick={handleAction}>
            {busy ? 'Please wait...' : 'Confirm'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
