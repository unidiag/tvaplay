
import React, { useEffect, useState } from 'react';
import {
  Box,
  CssBaseline,
  Container,
  ThemeProvider,
  Button,
} from '@mui/material';

import theme from './theme';
import Header from './components/Header';
import Channels from './pages/Channels';
import Packages from './pages/Packages';
import Users from './pages/Users';
import Sessions from './pages/Sessions';
import Messages from './pages/Messages';
import System from './pages/System';
import Settings from './pages/Settings';
import useHashPage from './hooks/useHashPage';
import { SnackbarProvider } from './hooks/useSnackbar';
import {
  apiRequest,
  refreshAccessToken,
} from './utils/api';
import Statistics from './pages/Statistics';

import './App.css';

const TOKEN_KEY = 'tvaplay_access_token';

const ADMIN_PAGES = [
  'channels',
  'packages',
  'users',
  'sessions',
  'messages',
  'statistics',
  'system',
  'settings',
];

function App() {
  const [page, setPage] = useHashPage(
    ADMIN_PAGES,
    'channels'
  );

  const [isAdmin, setIsAdmin] = useState(false);
  const [roleLoading, setRoleLoading] = useState(true);


  // ============================================================
  // BACKGROUND JWT REFRESH
  // ============================================================

  useEffect(() => {
    const refresh = async () => {
      try {
        await refreshAccessToken();
      } catch (error) {
        console.warn(
          '[AUTH] Token refresh failed:',
          error.message
        );
      }
    };

    // Проверяем JWT сразу после запуска приложения.
    refresh();

    // Проверяем JWT каждые 30 секунд.
    const timer = window.setInterval(refresh, 30000);

    // Проверяем JWT при возвращении на вкладку.
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    };

    document.addEventListener(
      'visibilitychange',
      onVisibilityChange
    );

    window.addEventListener('focus', refresh);

    // Проверяем JWT после выхода компьютера в сеть.
    window.addEventListener('online', refresh);

    return () => {
      window.clearInterval(timer);

      document.removeEventListener(
        'visibilitychange',
        onVisibilityChange
      );

      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
    };
  }, []);



  useEffect(() => {
    let active = true;

    async function loadRole() {
      try {
        const result = await apiRequest(
          'adminUsers',
          {},
          localStorage.getItem(TOKEN_KEY) || null
        );

        if (active) {
          setIsAdmin(
            Number(result.current_user_status) === 9
          );
        }
      } catch (err) {
        console.error('Failed to load user role:', err);

        if (active) {
          setIsAdmin(false);
        }
      } finally {
        if (active) {
          setRoleLoading(false);
        }
      }
    }

    loadRole();

    return () => {
      active = false;
    };
  }, []);

  const settingsAllowed = !roleLoading && isAdmin;

  useEffect(() => {
    if (
      !roleLoading &&
      !isAdmin &&
      page === 'settings'
    ) {
      setPage('channels');
    }
  }, [roleLoading, isAdmin, page, setPage]);

  const pages = {
    channels: <Channels />,
    packages: <Packages />,
    users: <Users />,
    sessions: <Sessions />,
    messages: <Messages />,
    system: <System />,
    statistics: <Statistics />,
    settings: settingsAllowed ? <Settings /> : null,
  };

  const visiblePage =
    page === 'settings' && !settingsAllowed
      ? 'channels'
      : page;


return (
  <ThemeProvider theme={theme}>
    <SnackbarProvider>
      <CssBaseline />

      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Header
          page={visiblePage}
          onPageChange={setPage}
          isAdmin={settingsAllowed}
        />

        <Container
          maxWidth="xl"
          sx={{
            py: 3,
            flex: 1,
          }}
        >
          {pages[visiblePage] || <Channels />}
        </Container>


<Box
  component="footer"
  sx={{
    mt: 'auto',
    py: 1.5,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 0.5,
    borderTop: 1,
    borderColor: 'divider',
    fontSize: '0.7rem',
    fontWeight: 400,
    color: 'text.secondary',
  }}
>
  <Box component="span">
    2026 Copyright by
  </Box>

  <Button
    component="a"
    href="https://tvaplay.com"
    target="_blank"
    rel="noopener noreferrer"
    size="small"
    color="inherit"
    sx={{
      fontSize: 'inherit',
      fontWeight: 'inherit',
      textTransform: 'none',
      color: 'inherit',
      minWidth: 0,
      minHeight: 24,
      p: 0,
      '&:hover': {
        color: 'primary.main',
      },
    }}
  >
    TVAPLAY.COM
  </Button>

  <Box component="span">|</Box>

  <Button
    component="a"
    href="https://tva.by"
    target="_blank"
    rel="noopener noreferrer"
    size="small"
    color="inherit"
    sx={{
      fontSize: 'inherit',
      fontWeight: 'inherit',
      textTransform: 'none',
      color: 'inherit',
      minWidth: 0,
      minHeight: 24,
      p: 0,
      '&:hover': {
        color: 'primary.main',
      },
    }}
  >
    TVA.BY
  </Button>
</Box>

      </Box>
    </SnackbarProvider>
  </ThemeProvider>
);

}

export default App;
