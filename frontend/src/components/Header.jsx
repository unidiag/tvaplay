import React from 'react';
import { AppBar, Toolbar, Typography, Tabs, Tab, Box, Container, Link } from '@mui/material';
import {
  LiveTv as ChannelsIcon,
  Inventory2Outlined as PackagesIcon,
  People as UsersIcon,
  Settings as SettingsIcon,
  Science as TestIcon,
} from '@mui/icons-material';

const menu = [
  { value: 'channels', label: 'Channels', icon: <ChannelsIcon /> },
  { value: 'packages', label: 'Packages', icon: <PackagesIcon /> },
  { value: 'users', label: 'Users', icon: <UsersIcon /> },
  { value: 'settings', label: 'Settings', icon: <SettingsIcon /> },
  { value: 'test', label: 'API Test', icon: <TestIcon /> },
];

export default function Header({ page, onPageChange }) {
  return (
    <AppBar position="sticky" elevation={1}>
      <Container maxWidth="xl">
        <Toolbar disableGutters sx={{ gap: 3, minHeight: 64 }}>
          <Link href="/" underline="none" color="inherit" sx={{
            display: 'flex', alignItems: 'center', textDecoration: 'none',
            '&:hover': { color: 'primary.main' },
          }}>
            <Typography variant="h6" sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>TVAPLAY</Typography>
          </Link>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Tabs value={page} onChange={(_, value) => onPageChange(value)} variant="scrollable"
              scrollButtons="auto" textColor="primary" indicatorColor="primary">
              {menu.map(item => <Tab key={item.value} value={item.value} label={item.label}
                icon={item.icon} iconPosition="start" />)}
            </Tabs>
          </Box>
        </Toolbar>
      </Container>
    </AppBar>
  );
}
