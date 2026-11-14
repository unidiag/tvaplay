
import React, { useEffect, useState } from 'react';
import {
  Box,
  CssBaseline,
  Container,
  ThemeProvider,
} from '@mui/material';

import theme from './theme';
import Header from './components/Header';
import Channels from './pages/Channels';
import Packages from './pages/Packages';
import Users from './pages/Users';
import Sessions from './pages/Sessions';
import Storages from './pages/Storages';
import Settings from './pages/Settings';
import useHashPage from './hooks/useHashPage';
import { SnackbarProvider } from './hooks/useSnackbar';
import { apiRequest } from './utils/api';
import Statistics from './pages/Statistics';

import './App.css';

const TOKEN_KEY = 'tvaplay_access_token';

const ADMIN_PAGES = [
  'channels',
  'packages',
  'users',
  'sessions',
  'storages',
  'statistics',
  'settings',
];

function App() {
  const [page, setPage] = useHashPage(
    ADMIN_PAGES,
    'channels'
  );

  const [isAdmin, setIsAdmin] = useState(false);
  const [roleLoading, setRoleLoading] = useState(true);

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
    storages: <Storages />,
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

        <Box sx={{ minHeight: '100vh' }}>
          <Header
            page={visiblePage}
            onPageChange={setPage}
            isAdmin={settingsAllowed}
          />

          <Container maxWidth="xl" sx={{ py: 3 }}>
            {pages[visiblePage] || <Channels />}
          </Container>
        </Box>
      </SnackbarProvider>
    </ThemeProvider>
  );
}

export default App;
