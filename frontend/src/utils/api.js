export const API_URL =
  process.env.REACT_APP_API_URL ||
  `${window.location.origin}/api`;

console.log('[TVAPLAY] API_URL:', API_URL);
console.log(
  '[TVAPLAY] REACT_APP_API_URL:',
  process.env.REACT_APP_API_URL
);

export async function apiRequest(op, params = {}, token = null) {
  const headers = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const body = JSON.stringify({
    ...params,
    op,
  });

  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    credentials: 'same-origin',
    body,
  });

  if (!response.ok) {
    throw new Error(`API HTTP ${response.status}`);
  }

  const result = await response.json();

  if (result.data?.status && result.data.status !== 'OK') {
    throw new Error(result.data.message || result.data.status);
  }

  return result.data;
}