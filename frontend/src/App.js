
import { useState } from 'react';

import TVPage from './TVPage';
import LoginPage from './components/LoginPage';

import './styles.css';

const AUTH_KEY = 'tvaplay.auth.v1';

const readAuth = () => {
  try {
    const auth = JSON.parse(
      localStorage.getItem(AUTH_KEY)
    );

    if (auth?.phone && auth?.createdAt) {
      return auth;
    }
  } catch {
    // Некорректные данные авторизации.
  }

  return null;
};

export default function App() {
  const [auth, setAuth] = useState(readAuth);

  const handleLogin = ({ phone }) => {
    const data = {
      phone,
      createdAt: Date.now(),
    };

    localStorage.setItem(
      AUTH_KEY,
      JSON.stringify(data)
    );

    setAuth(data);
  };

  const handleLogout = () => {
    localStorage.removeItem(AUTH_KEY);
    setAuth(null);
  };

  if (!auth) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return <TVPage onLogout={handleLogout} />;
}
