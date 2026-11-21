import useFeedback from '../hooks/useFeedback';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider, FormControl, MenuItem, Paper, Select, Stack, TextField, Tooltip, Typography, } from '@mui/material';
import { Add as AddIcon, DeleteOutlined as DeleteIcon, SettingsOutlined as SettingsIcon, TvOutlined as TvIcon, PeopleOutlined as PeopleIcon, PaymentsOutlined as PaymentsIcon, PaletteOutlined as PaletteIcon, SecurityOutlined as SecurityIcon, TuneOutlined as TuneIcon, } from '@mui/icons-material';
import { InputAdornment, IconButton } from '@mui/material';
import { Visibility as VisibilityIcon, VisibilityOff as VisibilityOffIcon, Autorenew as AutorenewIcon, } from '@mui/icons-material';
import { OpenInNew as OpenInNewIcon, } from '@mui/icons-material';
import { apiRequest } from '../utils/api';
import TemplatePhones from '../components/TemplatePhones';
const TOKEN_KEY = 'tvaplay_access_token';
const KEY_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;
const EMPTY_SETTING = { key: '', value: '', description: '' };
// Section and field order are explicit. Database position sorts only unknown keys.
const GROUPS = [
    {
        id: 'broadcast',
        title: 'Broadcast & Archive',
        subtitle: 'HLS streaming, EPG, promotional channel and archive access',
        icon: TvIcon,
        keys: ['epglink', 'start_hls_port', 'promo_chid', 'archive_trusted_proxy_ip'],
    },
    {
        id: 'subscribers',
        title: 'Subscribers & Subscriptions',
        subtitle: 'Registration, devices, discounts and subscriptions',
        icon: PeopleIcon,
        keys: [
            'phone_regex',
            'max_dev_for_new',
            'balance_for_new',
            'discount',
            'pause_tax',
            'resume_tax',
        ],
    },
    {
        id: 'payments',
        title: 'Payments',
        subtitle: 'Currency and balance top-up link',
        icon: PaymentsIcon,
        keys: ['currency', 'up_balance_url'],
    },
    {
        id: 'appearance',
        title: 'Appearance',
        subtitle: 'Branding, logo and interface information',
        icon: PaletteIcon,
        keys: ['brandname', 'logo_path', 'copyright'],
    },
    {
        id: 'integrations',
        title: 'Integrations, Access & app license information',
        subtitle: 'API key, JWT secret and SMS gateway',
        icon: SecurityIcon,
        keys: ['smsgate', 'api_key', 'jwt_token', 'hls_token', 'license'],
    },
];
const MULTILINE_KEYS = new Set(['copyright', 'license']);
const SENSITIVE_KEYS = new Set(['api_key', 'jwt_token', 'hls_token']);
const AMOUNT_KEYS = new Set([
    'balance_for_new',
    'pause_tax',
    'resume_tax',
]);
const MAX_LENGTH_KEYS = new Set(['currency', 'brandname']);
const messageOf = (err) => err instanceof Error ? err.message : String(err);
// Validate a single IP address (IPv4 or IPv6), without ports or CIDR masks.
function isValidIPAddress(value) {
    const ipv4 = (text) => {
        const parts = text.split('.');
        return parts.length === 4 && parts.every((part) => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255);
    };
    if (ipv4(value))
        return true;
    if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value))
        return false;
    // Support IPv4-mapped IPv6 addresses, e.g. ::ffff:192.168.1.1.
    let ip = value;
    if (ip.includes('.')) {
        const lastColon = ip.lastIndexOf(':');
        const tail = ip.slice(lastColon + 1);
        if (!ipv4(tail))
            return false;
        ip = ip.slice(0, lastColon + 1) + '0:0';
    }
    const halves = ip.split('::');
    if (halves.length > 2)
        return false;
    const groups = halves.reduce((result, half) => {
        if (half)
            result.push(...half.split(':'));
        return result;
    }, []);
    if (!groups.every((group) => /^[0-9a-fA-F]{1,4}$/.test(group)))
        return false;
    const count = groups.length; // Embedded IPv4 already represented as 0:0.
    return halves.length === 2 ? count < 8 : count === 8;
}
function validateMaxLength(value, maxLength = 16) {
    const text = String(value ?? '');
    if (!text.trim()) {
        return 'This field cannot be empty.';
    }
    if (Array.from(text).length > maxLength) {
        return `Maximum length is ${maxLength} characters.`;
    }
    return '';
}
function validateJWTSecret(value) {
    const text = String(value ?? '');
    if (text.length < 32 || text.length > 64) {
        return 'JWT secret must contain between 32 and 64 characters.';
    }
    if (!/^[A-Za-z0-9]+$/.test(text)) {
        return 'JWT secret must contain only Latin letters and digits.';
    }
    return '';
}
function validateHLSToken(value) {
    const text = String(value ?? '');
    if (text.length !== 32) {
        return 'HLS token must contain exactly 32 characters.';
    }
    if (!/^[A-Za-z0-9]+$/.test(text)) {
        return 'HLS token must contain only Latin letters and digits.';
    }
    return '';
}
function validateUrl(value) {
    const text = String(value ?? '').trim();
    if (!text) {
        return 'Enter a URL.';
    }
    try {
        const url = new URL(text);
        if (!['http:', 'https:'].includes(url.protocol) ||
            !url.hostname ||
            url.username ||
            url.password) {
            return 'Enter a valid HTTP or HTTPS URL.';
        }
        return '';
    }
    catch {
        return 'Enter a valid URL (e.g. https://example.com/payment).';
    }
}
function validatePhoneRegex(value) {
    const pattern = String(value ?? '').trim();
    if (!pattern) {
        return 'Enter a phone number regular expression.';
    }
    // Require a full-number match.
    if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
        return 'Regular expression must start with ^ and end with $.';
    }
    // Require international E.164 prefix.
    if (!pattern.startsWith(String.raw`^\+`)) {
        return 'Regular expression must start with ^\\\\\\\\+.';
    }
    // Reject constructs unsupported by Go regexp (RE2).
    if (/\(\?/.test(pattern) ||
        /\\[1-9]/.test(pattern) ||
        /\(\?>/.test(pattern)) {
        return 'Unsupported regular expression syntax for RE2.';
    }
    try {
        new RegExp(pattern);
    }
    catch (_) {
        return 'Invalid regular expression syntax.';
    }
    return '';
}
function validateScriptPath(value) {
    const text = String(value ?? '').trim();
    if (!text) {
        return 'Enter the absolute path to the SMS gateway script.';
    }
    if (!text.startsWith('/')) {
        return 'Script path must be absolute (e.g. /usr/local/bin/send_sms.sh).';
    }
    if (/[\0\r\n]/.test(text)) {
        return 'Script path contains invalid characters.';
    }
    if (text.split('/').some((part) => part === '.' || part === '..')) {
        return 'Script path must not contain . or .. segments.';
    }
    if (!/^\/(?:[^/\0\r\n]+\/)*[^/\0\r\n]+$/.test(text)) {
        return 'Enter a valid absolute path to the script.';
    }
    return '';
}
function validateLogoPath(value) {
    const text = String(value ?? '').trim();
    if (!text) {
        return ''; // Empty value is allowed.
    }
    if (!text.startsWith('/')) {
        return 'Logo path must be absolute (e.g. /var/www/logo.png).';
    }
    if (/[\0\r\n]/.test(text)) {
        return 'Logo path contains invalid characters.';
    }
    if (!/^\/(?:[^/\0\r\n]+\/)*[^/\0\r\n]+\.png$/i.test(text)) {
        return 'Enter an absolute path ending in .png.';
    }
    if (text.split('/').some((part) => part === '.' || part === '..')) {
        return 'Logo path must not contain . or .. segments.';
    }
    return '';
}
function validateAmount(value) {
    const text = String(value ?? '').trim();
    if (!text) {
        return 'Enter an amount.';
    }
    // Allow integers and decimals with up to 2 digits after the dot.
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
        return 'Enter a valid amount (e.g. 10 or 10.50).';
    }
    if (!Number.isFinite(Number(text))) {
        return 'Amount is too large.';
    }
    return '';
}
function formatLicenseDate(unix) {
    const seconds = Number(unix);
    if (!Number.isSafeInteger(seconds) || seconds <= 0)
        return '—';
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime()))
        return '—';
    return new Intl.DateTimeFormat('ru-RU', {
        day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC',
    }).format(date);
}
// License signature/MAC/user-count checks must be made by the Go backend.
// No frontend Base64 decoding is treated as signature verification.
function readLicenseMeta(result) {
    const setting = Array.isArray(result?.settings)
        ? result.settings.find((item) => item.key === 'license')
        : undefined;
    const meta = result?.license_meta ?? result?.licenseMeta ?? setting;
    if (!meta || typeof meta !== 'object')
        return { checked: false, valid: false, expiredAt: 0, maxUsers: 0 };
    const valid = meta.valid ?? meta.license_valid;
    const expiry = meta.e ?? meta.expired_at ?? meta.expiredAt ?? meta.license_expired_at;
    const maxUsers = meta.u ?? meta.max_users ?? meta.maxUsers ?? meta.license_max_users;
    return {
        checked: typeof valid === 'boolean',
        valid: valid === true,
        expiredAt: Number(expiry) || 0,
        maxUsers: Number(maxUsers) || 0,
    };
}
function validateDiscount(value) {
    const text = String(value ?? '').trim();
    if (!text) {
        return 'Enter a discount percentage.';
    }
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
        return 'Enter a valid percentage (e.g. 10 or 12.5).';
    }
    const discount = Number(text);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
        return 'Discount must be between 0 and 100%.';
    }
    return '';
}
// Returns an error message for known setting keys, or an empty string if valid.
// Keep unknown keys unrestricted so custom settings continue to work.
export function validateSettingValue(key, value) {
    if (key === 'hls_token') {
        return validateHLSToken(value);
    }
    if (key === 'jwt_token') {
        return validateJWTSecret(value);
    }
    if (key === 'smsgate') {
        return validateScriptPath(value);
    }
    if (key === 'logo_path') {
        return validateLogoPath(value);
    }
    if (MAX_LENGTH_KEYS.has(key)) {
        return validateMaxLength(value);
    }
    if (key === 'up_balance_url') {
        return validateUrl(value);
    }
    if (AMOUNT_KEYS.has(key)) {
        return validateAmount(value);
    }
    if (key === 'discount') {
        return validateDiscount(value);
    }
    if (key === 'phone_regex') {
        return validatePhoneRegex(value);
    }
    const text = String(value ?? '').trim();
    if (key === 'archive_trusted_proxy_ip') {
        if (!isValidIPAddress(text)) {
            return 'Enter a valid IPv4 or IPv6 address without a port or CIDR mask.';
        }
        return '';
    }
    if (key === 'start_hls_port') {
        if (!/^[0-9]+$/.test(text)) {
            return 'Enter a whole number from 10000 to 65000.';
        }
        const port = Number(text);
        if (!Number.isSafeInteger(port) || port < 10000 || port > 65000) {
            return 'HLS port must be between 10000 and 65000.';
        }
        return '';
    }
    if (key === 'epglink') {
        if (!text) {
            return 'Enter an HTTP(S) URL or an absolute path to an .xml or .gz file.';
        }
        if (/^https?:\/\//i.test(text)) {
            try {
                const url = new URL(text);
                if (!url.hostname || !/^https?:$/.test(url.protocol) || /\s/.test(text)) {
                    return 'Enter a valid http:// or https:// URL.';
                }
                return '';
            }
            catch (_) {
                return 'Enter a valid http:// or https:// URL.';
            }
        }
        // Local paths are absolute POSIX paths on the Linux server.
        // The UI cannot verify that a file actually exists on disk.
        if (/^\/(?:[^/\0\r\n]+\/)*[^/\0\r\n]+\.(?:xml|gz)$/i.test(text)) {
            return '';
        }
        return 'Enter an HTTP(S) URL or an absolute path ending in .xml or .gz.';
    }
    return '';
}
function sortByPositionThenKey(a, b) {
    const positionA = Number(a.position) || 0;
    const positionB = Number(b.position) || 0;
    return positionA - positionB || String(a.key).localeCompare(String(b.key));
}
function generateString(length = 20) {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const bytes = new Uint8Array(length);
    const result = [];
    if (!window.crypto || !window.crypto.getRandomValues) {
        throw new Error('Secure random generator is unavailable');
    }
    // Исключаем смещение распределения при выборе символов.
    while (result.length < length) {
        window.crypto.getRandomValues(bytes);
        for (let i = 0; i < bytes.length && result.length < length; i++) {
            if (bytes[i] < 248) {
                result.push(chars[bytes[i] % chars.length]);
            }
        }
    }
    return result.join('');
}
function SettingField({ setting, debug, draftValue, draftDescription, saving, channels, channelsLoading, channelsError, onValueChange, onDescriptionChange, onSave, onDelete, onGetLicense, licenseMeta, }) {
    const key = setting.key;
    const originalValue = setting.value ?? '';
    const originalDescription = setting.description ?? '';
    const value = draftValue ?? originalValue;
    const description = debug
        ? (draftDescription ?? originalDescription)
        : originalDescription;
    const changed = value !== originalValue ||
        (debug && description !== originalDescription);
    const isMultiline = MULTILINE_KEYS.has(key);
    const isSensitive = SENSITIVE_KEYS.has(key);
    const DEVICE_LIMIT_OPTIONS = [1, 2, 3, 4, 5, 10, 15, 30];
    const validationError = validateSettingValue(key, value);
    const showValidationError = draftValue !== undefined && Boolean(validationError);
    const [showSecret, setShowSecret] = useState(false);
    const [gettingLicense, setGettingLicense] = useState(false);
    const isLicenseField = key === 'license';
    const isLicenseEdited = isLicenseField && value !== originalValue;
    const isLicenseInvalid = isLicenseField && (!String(value).trim() ||
        isLicenseEdited ||
        (licenseMeta?.checked === true && licenseMeta.valid !== true));
    const fieldError = showValidationError || isLicenseInvalid;
    const fieldHelperText = showValidationError
        ? validationError
        : isLicenseInvalid
            ? (isLicenseEdited ? 'Save license to verify' : 'License is invalid')
            : undefined;
    const handleGetLicense = async () => {
        if (gettingLicense || saving)
            return;
        // Открываем вкладку синхронно, чтобы браузер
        // не заблокировал её после асинхронного запроса.
        const tab = window.open('about:blank', '_blank');
        if (!tab) {
            console.error('Browser blocked the license window');
            return;
        }
        try {
            setGettingLicense(true);
            const url = await onGetLicense();
            // Проверяем адрес, возвращённый сервером.
            const target = new URL(url);
            if (target.protocol !== 'https:' ||
                target.hostname !== 'tvaplay.com' ||
                target.pathname !== '/license/') {
                throw new Error('Invalid license activation URL');
            }
            tab.location.replace(target.href);
        }
        catch (error) {
            tab.close();
            console.error('Failed to generate license activation:', error);
        }
        finally {
            setGettingLicense(false);
        }
    };
    const handleGenerateSecret = () => {
        try {
            const length = 32;
            const newSecret = generateString(length);
            onValueChange(key, newSecret);
            setShowSecret(true);
        }
        catch (error) {
            console.error('Failed to generate secret:', error);
        }
    };
    return (<Box sx={{ py: 2.25 }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'stretch', sm: 'flex-start' }} spacing={2}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 1.25, minWidth: 0 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {key === 'license' ? (<Stack spacing={debug ? 1 : 0}>
                  <Box>
                    <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500 }}>
                      License key
                    </Typography>
                    <Typography variant="caption" sx={{
                display: 'block',
                mt: 0.5,
                fontSize: '11px',
                color: isLicenseInvalid ? 'error.main' : 'text.secondary',
            }}>
                      {isLicenseEdited
                ? 'Save license to verify its details'
                : licenseMeta?.checked
                    ? `Expired: ${formatLicenseDate(licenseMeta.expiredAt)}    Max Users: ${licenseMeta.maxUsers}`
                    : 'License status unavailable'}
                    </Typography>
                  </Box>
                  {debug && (<TextField fullWidth size="small" label="Description" value={description} disabled={saving} onChange={(event) => onDescriptionChange(key, event.target.value)}/>)}
                </Stack>) : debug ? (<TextField fullWidth size="small" label="Description" value={description} disabled={saving} onChange={(event) => onDescriptionChange(key, event.target.value)}/>) : description ? (<Typography variant="body2" color="text.secondary" sx={{
                fontWeight: 500,
                overflowWrap: 'anywhere',
            }}>
                  {description}
                </Typography>) : null}
            </Box>
            {key === 'phone_regex' && (<TemplatePhones disabled={saving} onSelect={(regex) => onValueChange(key, regex)}/>)}
            {key === 'license' && (<Button size="small" variant="outlined" color="primary" startIcon={gettingLicense
                ? <CircularProgress size={14} color="inherit"/>
                : <OpenInNewIcon fontSize="small"/>} disabled={saving || gettingLicense} onClick={handleGetLicense} sx={{
                minWidth: 'auto',
                flexShrink: 0,
                px: 1.25,
                minHeight: 28,
              height: 28,
              py: 0,
                fontSize: '0.7rem',
                textTransform: 'none',
                whiteSpace: 'nowrap',
            }}>
                Get license
              </Button>)}
          </Stack>
            {key === 'max_dev_for_new' ? (
                <FormControl
                  fullWidth
                  size="small"
                  disabled={saving || licenseMeta?.valid !== true}
                  error={licenseMeta?.valid !== true && Number(value) > 1}
                  sx={{
                  ...(licenseMeta?.valid !== true && Number(value) > 1 && {
                    '& .MuiOutlinedInput-root.Mui-disabled .MuiOutlinedInput-notchedOutline': {
                      borderColor: 'error.main',
                      borderWidth: '1px',
                    },
                  }),
                }}
                >
                  <Select
                    value={String(value)}
                    onChange={(event) =>
                      onValueChange(key, String(event.target.value))
                    }
                    inputProps={{
                      'aria-label': description || 'Maximum number of devices',
                    }}
                  >
                    {DEVICE_LIMIT_OPTIONS.map((limit) => (
                      <MenuItem key={limit} value={String(limit)}>
                        {limit}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>) : key === 'promo_chid' ? (<>
              <FormControl fullWidth size="small" disabled={saving || channelsLoading}>
                <Select value={String(value)} displayEmpty onChange={(event) => onValueChange(key, String(event.target.value))} inputProps={{ 'aria-label': description || 'Promotional channel' }}>
                  <MenuItem value="">
                    <em>Not selected</em>
                  </MenuItem>
                  {value !== '' && !channels.some((channel) => String(channel.id) === String(value)) && (<MenuItem value={String(value)}>
                      Channel #{value} (not found)
                    </MenuItem>)}
                  {channels.map((channel) => (<MenuItem key={channel.id} value={String(channel.id)}>
                      {channel.name} (#{channel.id})
                    </MenuItem>))}
                </Select>
              </FormControl>
              {channelsLoading && (<Typography variant="caption" color="text.secondary">
                  Loading channels...
                </Typography>)}
              {channelsError && (<Typography variant="caption" color="error">
                  {channelsError}
                </Typography>)}
            </>) : (<TextField fullWidth size="small" value={value} disabled={saving} onChange={(event) => onValueChange(key, event.target.value)} error={fieldError} helperText={fieldHelperText} multiline={isMultiline} rows={key === 'license' ? 3 : undefined} minRows={key === 'copyright' ? 2 : undefined} maxRows={key === 'copyright' ? 5 : undefined} type={isMultiline
                ? undefined
                : isSensitive && !showSecret
                    ? 'password'
                    : 'text'} autoComplete="off" slotProps={{
                input: {
                    ...(isSensitive && {
                        endAdornment: (<InputAdornment position="end">
                        <IconButton size="small" disabled={saving} title={key === 'jwt_token'
                                ? 'Generate new JWT secret'
                                : 'Generate new API key'} aria-label={key === 'jwt_token'
                                ? 'Generate new JWT secret'
                                : 'Generate new API key'} onClick={handleGenerateSecret} onMouseDown={(event) => event.preventDefault()}>
                          <AutorenewIcon fontSize="small"/>
                        </IconButton>
                        <IconButton size="small" disabled={saving} title={showSecret ? 'Hide secret' : 'Show secret'} aria-label={showSecret ? 'Hide secret' : 'Show secret'} onClick={() => setShowSecret((prev) => !prev)} onMouseDown={(event) => event.preventDefault()}>
                          {showSecret ? (<VisibilityOffIcon fontSize="small"/>) : (<VisibilityIcon fontSize="small"/>)}
                        </IconButton>
                      </InputAdornment>),
                    }),
                },
                htmlInput: {
                    ...(isSensitive && {
                        autoComplete: 'new-password',
                    }),
                    ...(key === 'license' && {
                        style: {
                            fontFamily: 'monospace',
                            fontSize: '12px',
                            lineHeight: '1.5',
                        },
                    }),
                    ...(key === 'start_hls_port' && {
                        inputMode: 'numeric',
                    }),
                    ...((AMOUNT_KEYS.has(key) || key === 'discount') && {
                        inputMode: 'decimal',
                    }),
                    ...(key === 'up_balance_url' && {
                        inputMode: 'url',
                    }),
                    ...(MAX_LENGTH_KEYS.has(key) && {
                        maxLength: 16,
                    }),
                    ...(key === 'jwt_token' && {
                        maxLength: 64,
                    }),
                    ...(key === 'hls_token' && {
                        maxLength: 32,
                    }),
                },
            }}/>)}
        </Box>
        <Stack direction="row" spacing={0.75} sx={{ pt: { xs: 0, sm: debug ? 4 : 0 }, flexShrink: 0, alignSelf: { xs: 'flex-end', sm: 'flex-end' } }}>
          {changed && !validationError && (<Button size="small" variant="contained" sx={{
                minWidth: 64,
                minHeight: 28,
                px: 1.25,
                py: 0.25,
                fontSize: '0.75rem',
                lineHeight: 1.5,
            }} disabled={saving} onClick={() => onSave(setting)}>
              Save
            </Button>)}
          {debug && (<Tooltip title="Delete setting">
              <span>
                <Button size="small" color="error" variant="outlined" aria-label={`Delete setting: ${description || key}`} disabled={saving} onClick={() => onDelete(setting)} sx={{ minWidth: 38, px: 1 }}>
                  <DeleteIcon fontSize="small"/>
                </Button>
              </span>
            </Tooltip>)}
        </Stack>
      </Stack>
    </Box>);
}
export default function Settings() {
    const [settings, setSettings] = useState([]);
    const [licenseMeta, setLicenseMeta] = useState({ checked: false, valid: false, expiredAt: 0, maxUsers: 0 });
    const [channels, setChannels] = useState([]);
    const [channelsLoading, setChannelsLoading] = useState(true);
    const [channelsError, setChannelsError] = useState('');
    const [values, setValues] = useState({});
    const [descriptions, setDescriptions] = useState({});
    const [debug, setDebug] = useState(false);
    const [debugView, setDebugView] = useState(false);
    const isDebug = debug && debugView;
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [adding, setAdding] = useState(false);
    const [newSetting, setNewSetting] = useState({ ...EMPTY_SETTING });
    const { setError, setNotice } = useFeedback();
    const request = useCallback((op, params = {}) => apiRequest(op, params, localStorage.getItem(TOKEN_KEY) || null), []);
    const applyResponse = useCallback((result) => {
        setSettings(Array.isArray(result.settings) ? result.settings : []);
        setLicenseMeta(readLicenseMeta(result));
        const serverDebug = result.debug === true;
        setDebug(serverDebug);
        setDebugView((prev) => serverDebug && prev);
        setValues({});
        setDescriptions({});
    }, []);
    const loadSettings = useCallback(async () => {
        const result = await request('adminSettings');
        applyResponse(result);
    }, [request, applyResponse]);
    useEffect(() => {
        let active = true;
        setLoading(true);
        setError('');
        request('adminSettings')
            .then((result) => {
            if (active)
                applyResponse(result);
        })
            .catch((err) => {
            if (active)
                setError(messageOf(err));
        })
            .finally(() => {
            if (active)
                setLoading(false);
        });
        return () => { active = false; };
    }, [request, applyResponse, setError]);
    // Reuse the same channel-list API as the Channels page.
    useEffect(() => {
        let active = true;
        request('adminChannels')
            .then((result) => {
            if (!active)
                return;
            const list = Array.isArray(result.channels) ? result.channels : [];
            setChannels([...list].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) ||
                Number(a.id) - Number(b.id)));
            setChannelsError('');
        })
            .catch((err) => {
            if (active)
                setChannelsError(`Failed to load channels: ${messageOf(err)}`);
        })
            .finally(() => {
            if (active)
                setChannelsLoading(false);
        });
        return () => { active = false; };
    }, [request]);
    const groupedSettings = useMemo(() => {
        const byKey = new Map(settings.map((setting) => [setting.key, setting]));
        const known = new Set(GROUPS.flatMap((group) => group.keys));
        const result = GROUPS.map((group) => ({
            ...group,
            items: group.keys
                .map((key) => byKey.get(key))
                .filter(Boolean),
        })).filter((group) => group.items.length > 0);
        const other = settings
            .filter((setting) => !known.has(setting.key))
            .sort(sortByPositionThenKey);
        if (other.length) {
            result.push({
                id: 'other',
                title: 'Additional Settings',
                subtitle: 'Settings not assigned to a predefined group',
                icon: TuneIcon,
                items: other,
            });
        }
        return result;
    }, [settings]);
    const changeValue = (key, value) => setValues((prev) => ({ ...prev, [key]: value }));
    const changeDescription = (key, value) => {
        if (!isDebug)
            return;
        setDescriptions((prev) => ({ ...prev, [key]: value }));
    };
    const getLicenseActivation = async () => {
        try {
            setError('');
            const result = await request('adminLicenseActivation');
            if (!result.url) {
                throw new Error('License activation URL is missing');
            }
            return result.url;
        }
        catch (error) {
            setError(messageOf(error));
            throw error;
        }
    };
    const saveSetting = async (setting) => {
        const nextValue = values[setting.key] ?? setting.value ?? '';
        const validationError = validateSettingValue(setting.key, nextValue);
        if (validationError) {
            setError(validationError);
            return;
        }
        setSaving(true);
        setError('');
        setNotice('');
        try {
            const params = {
                key: setting.key,
                value: nextValue,
            };
            // In production mode, do not submit the description field.
            if (isDebug) {
                params.description = descriptions[setting.key] ?? setting.description ?? '';
            }
            await request('adminSettingSave', params);
            await loadSettings();
            setNotice('Setting saved successfully');
        }
        catch (err) {
            setError(messageOf(err));
        }
        finally {
            setSaving(false);
        }
    };
    const addSetting = async () => {
        if (!isDebug)
            return;
        const key = newSetting.key.trim();
        if (!KEY_PATTERN.test(key)) {
            setError('Invalid setting key');
            return;
        }
        if (settings.some((setting) => setting.key === key)) {
            setError('A setting with this key already exists');
            return;
        }
        setSaving(true);
        setError('');
        setNotice('');
        try {
            await request('adminSettingSave', { ...newSetting, key, create: true });
            await loadSettings();
            setNewSetting({ ...EMPTY_SETTING });
            setAdding(false);
            setNotice('Setting added successfully');
        }
        catch (err) {
            setError(messageOf(err));
        }
        finally {
            setSaving(false);
        }
    };
    const deleteSetting = async (setting) => {
        if (!isDebug)
            return;
        const label = setting.description || setting.key;
        if (!window.confirm(`Delete setting "${label}"?`))
            return;
        setSaving(true);
        setError('');
        setNotice('');
        try {
            await request('adminSettingDelete', { key: setting.key });
            await loadSettings();
            setNotice('Setting deleted successfully');
        }
        catch (err) {
            setError(messageOf(err));
        }
        finally {
            setSaving(false);
        }
    };
    return (<Box sx={{ pb: 4 }}>
      <Box sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            alignItems: 'center',
            columnGap: 2,
            width: '100%',
            mb: 3,
        }}>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ minWidth: 0 }}>
          <Box sx={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 44, height: 44, borderRadius: 2, flexShrink: 0,
            bgcolor: 'action.hover', color: 'primary.main',
        }}>
            <SettingsIcon />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
              <Typography variant="h5" fontWeight={700}>Settings</Typography>
              {debug && (<Chip label={debugView ? 'DEBUG ON' : 'DEBUG OFF'} size="small" color={debugView ? 'warning' : 'default'} variant={debugView ? 'filled' : 'outlined'} clickable disabled={saving} onClick={() => {
                setDebugView((prev) => !prev);
                setAdding(false);
            }} sx={{
                cursor: 'pointer', fontWeight: 600, fontSize: '0.7rem',
                height: 24, userSelect: 'none',
            }}/>)}
            </Stack>
            <Typography variant="body2" color="text.secondary">
              TVAPLAY system settings
            </Typography>
          </Box>
        </Stack>
        {isDebug && (<Box sx={{ justifySelf: 'end' }}>
            <Button size="small" variant="contained" startIcon={<AddIcon fontSize="small"/>} disabled={loading || saving} onClick={() => setAdding(true)} sx={{
                flexShrink: 0, px: 1.5, py: 0.5,
                minHeight: 30, fontSize: '0.75rem',
                textTransform: 'none', whiteSpace: 'nowrap',
            }}>
              Add Setting
            </Button>
          </Box>)}
      </Box>
      {loading ? (<Box sx={{ py: 8, display: 'flex', justifyContent: 'center' }}>
          <CircularProgress />
        </Box>) : groupedSettings.length ? (<Box sx={{
                columnCount: { xs: 1, lg: 2 },
                columnGap: 2.5,
            }}>
          {groupedSettings.map((group) => {
                const Icon = group.icon;
                return (<Paper key={group.id} variant="outlined" sx={{
                        borderRadius: 2.5,
                        overflow: 'hidden',
                        breakInside: 'avoid',
                        pageBreakInside: 'avoid',
                        display: 'inline-block',
                        width: '100%',
                        mb: 2.5,
                        verticalAlign: 'top',
                    }}>
                <Box sx={{ px: { xs: 2, sm: 2.5 }, pt: 2.25, pb: 1.5 }}>
                  <Stack direction="row" spacing={1.25} alignItems="flex-start">
                    <Box sx={{ color: 'primary.main', mt: 0.25 }}><Icon /></Box>
                    <Box sx={{ minWidth: 0 }}>
                      <Typography variant="h6" fontWeight={650}>
                        {group.title}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {group.subtitle}
                      </Typography>
                    </Box>
                  </Stack>
                </Box>
                <Divider />
                <Box sx={{ px: { xs: 2, sm: 2.5 } }}>
                  {group.items.map((setting, index) => (<React.Fragment key={setting.key}>
                      {index > 0 && <Divider />}
                      <SettingField setting={setting} debug={isDebug} draftValue={values[setting.key]} draftDescription={descriptions[setting.key]} saving={saving} channels={channels} channelsLoading={channelsLoading} channelsError={channelsError} onValueChange={changeValue} onDescriptionChange={changeDescription} onSave={saveSetting} onDelete={deleteSetting} onGetLicense={getLicenseActivation} licenseMeta={licenseMeta}/>
                    </React.Fragment>))}
                </Box>
              </Paper>);
            })}
        </Box>) : (<Paper variant="outlined" sx={{ py: 7, textAlign: 'center', borderRadius: 2.5 }}>
          <Typography color="text.secondary">No settings found</Typography>
        </Paper>)}
      {isDebug && (<Dialog open={adding} onClose={() => { if (!saving)
            setAdding(false); }} fullWidth maxWidth="sm">
          <DialogTitle>Add Setting</DialogTitle>
          <DialogContent>
            <Stack spacing={2} sx={{ mt: 1 }}>
              <TextField fullWidth label="Key" placeholder="example_setting" value={newSetting.key} disabled={saving} onChange={(event) => setNewSetting((prev) => ({ ...prev, key: event.target.value }))} helperText="Lowercase letters, digits, underscores, hyphens and dots; start with a letter"/>
              <TextField fullWidth label="Value" value={newSetting.value} disabled={saving} onChange={(event) => setNewSetting((prev) => ({ ...prev, value: event.target.value }))}/>
              <TextField fullWidth label="Description" value={newSetting.description} disabled={saving} multiline minRows={2} onChange={(event) => setNewSetting((prev) => ({ ...prev, description: event.target.value }))}/>
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button disabled={saving} onClick={() => setAdding(false)}>Cancel</Button>
            <Button variant="contained" disabled={saving || !KEY_PATTERN.test(newSetting.key.trim())} onClick={addSetting}>
              Add
            </Button>
          </DialogActions>
        </Dialog>)}
    </Box>);
}
