import React, { useState } from 'react';
import { Box, CssBaseline, Container, ThemeProvider } from '@mui/material';
import theme from './theme';
import Header from './components/Header';
import Channels from './pages/Channels';
import Packages from './pages/Packages';
import Users from './pages/Users';
import Settings from './pages/Settings';
import Test from './pages/Test';
import './App.css';

function App() {
  const [page, setPage] = useState('channels');
  const pages = {
    channels: <Channels />,
    packages: <Packages />,
    users: <Users />,
    settings: <Settings />,
    test: <Test />,
  };
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ minHeight: '100vh' }}>
        <Header page={page} onPageChange={setPage} />
        <Container maxWidth="xl" sx={{ py: 3 }}>
          {pages[page] || <Channels />}
        </Container>
      </Box>
    </ThemeProvider>
  );
}
export default App;
