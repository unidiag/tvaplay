export const API_URL =
  process.env.REACT_APP_API_URL ||
  `${window.location.origin}/api`;

const IS_DEV = process.env.NODE_ENV === 'development';

const ACCESS_KEY = 'tvaplay_access_token';
const REFRESH_KEY = 'tvaplay_refresh_token';

// Обновляем JWT за 60 секунд до окончания срока действия.
const REFRESH_BEFORE = 60 * 1000;

// Общий Promise для предотвращения параллельных refresh.
let refreshPromise = null;


// ============================================================
// JWT EXPIRATION
// ============================================================

function getTokenExpiration(token) {
  if (!token) {
    return 0;
  }

  try {
    const payload = token.split('.')[1];

    const base64 = payload
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    const claims = JSON.parse(atob(base64));

    return Number(claims.exp || 0) * 1000;
  } catch {
    return 0;
  }
}


// ============================================================
// RAW API REQUEST
// ============================================================

async function rawRequest(op, params = {}, token = null) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body: JSON.stringify({
      ...params,
      op,
    }),
  });

  if (!response.ok) {
    const error = new Error(`API HTTP ${response.status}`);

    error.httpStatus = response.status;

    throw error;
  }

  const result = await response.json();

  return result.data;
}


// ============================================================
// ADMIN COOKIE
// ============================================================

async function updateAdminSession(token) {

  if (IS_DEV) {
    return;
  }

  // В режиме разработки административная
  // cookie не требуется.
  if (process.env.NODE_ENV === 'development') {
    return;
  }

  const response = await fetch('/admin/session', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
    },
    credentials: 'same-origin',
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(
      `Admin session HTTP ${response.status}`
    );
  }
}


// ============================================================
// REFRESH ACCESS TOKEN
// ============================================================

export async function refreshAccessToken(force = false) {
  // Если обновление уже выполняется — ожидаем его.
  if (refreshPromise) {
    return refreshPromise;
  }

  const accessToken = localStorage.getItem(ACCESS_KEY);

  const expiresAt = getTokenExpiration(accessToken);

  // JWT ещё достаточно долго действителен.
  if (
    !force &&
    accessToken &&
    expiresAt > Date.now() + REFRESH_BEFORE
  ) {
    return accessToken;
  }

  const refreshToken = localStorage.getItem(REFRESH_KEY);

  // Совместимость с режимом разработки.
  if (IS_DEV && !refreshToken) {
    return accessToken;
  }

  if (!refreshToken) {
    // Сохраняем возможность использовать ещё действующий JWT.
    if (
      !force &&
      accessToken &&
      expiresAt > Date.now()
    ) {
      return accessToken;
    }

    throw new Error('Authorization expired');
  }

  refreshPromise = (async () => {
    const data = await rawRequest('authRefresh', {
      refresh_token: refreshToken,
    });

    if (
      data?.status !== 'OK' ||
      !data.access_token
    ) {
      throw new Error(
        data?.message ||
        data?.status ||
        'Authorization expired'
      );
    }

    // Сервер может одновременно перевыпустить refresh token.
    if (data.refresh_token) {
      localStorage.setItem(
        REFRESH_KEY,
        data.refresh_token
      );
    }

    // Продлеваем HttpOnly cookie административной панели.
    await updateAdminSession(data.access_token);

    localStorage.setItem(
      ACCESS_KEY,
      data.access_token
    );

    console.debug(
      '[AUTH] Access token refreshed',
      new Date(
        getTokenExpiration(data.access_token)
      ).toLocaleString()
    );

    return data.access_token;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}


// ============================================================
// API REQUEST
// ============================================================

export async function apiRequest(
  op,
  params = {},
  token = null
) {
  const requiresAdmin = op.startsWith('admin');

  if (requiresAdmin) {
    if (
      IS_DEV &&
      !localStorage.getItem(REFRESH_KEY)
    ) {
      token = token || localStorage.getItem(ACCESS_KEY);
    } else {
      token = await refreshAccessToken();
    }
  }

  let data;

  try {
    data = await rawRequest(op, params, token);
  } catch (error) {
    // HTTP 401 — обновляем токен и повторяем запрос один раз.
    if (requiresAdmin && error.httpStatus === 401) {
      token = await refreshAccessToken(true);

      data = await rawRequest(op, params, token);
    } else {
      throw error;
    }
  }

  // JWT мог истечь непосредственно во время запроса.
  if (
    requiresAdmin &&
    data?.status === 'FORBIDDEN' &&
    getTokenExpiration(token) <= Date.now()
  ) {
    token = await refreshAccessToken(true);

    data = await rawRequest(op, params, token);
  }

  if (data?.status && data.status !== 'OK') {
    throw new Error(data.message || data.status);
  }

  return data;
}