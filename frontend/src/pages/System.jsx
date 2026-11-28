
import React, { useState } from 'react';
import {
  Box,
  Button,
  Stack,
  Divider,
  Typography,
} from '@mui/material';

import MemoryIcon from '@mui/icons-material/Memory';
import LanOutlinedIcon from '@mui/icons-material/LanOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';

import Storages from '../components/SystemStorages';
import SystemCpuRam from '../components/SystemCpuRam';
import SystemInterfaces from '../components/SystemInterfaces';

const sections = [
  {
    id: 'cpu',
    label: 'CPU / RAM',
    icon: <MemoryIcon />,
  },
  {
    id: 'interfaces',
    label: 'Interfaces',
    icon: <LanOutlinedIcon />,
  },
  {
    id: 'storages',
    label: 'Storages',
    icon: <StorageOutlinedIcon />,
  },
];

export default function System() {
  const [section, setSection] = useState('cpu');

  return (
    <Box>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        sx={{
          mb: 2,
          width: '100%',
          justifyContent: 'space-between',
          alignItems: {
            xs: 'stretch',
            md: 'center',
          },
        }}
      >
        {/* Page header */}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="h5" fontWeight={700}>
            System
          </Typography>
        </Box>

        {/* Section navigation */}
        <Stack
          direction="row"
          spacing={1}
          useFlexGap
          sx={{
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            flexShrink: 0,
          }}
        >
          {sections.map((item) => (
            <Button
              key={item.id}
              variant={
                section === item.id
                  ? 'contained'
                  : 'outlined'
              }
              color="primary"
              size="small"
              startIcon={item.icon}
              onClick={() => setSection(item.id)}
              aria-pressed={section === item.id}
              sx={{
                textTransform: 'none',
                minWidth: 130,
                height: 36,
                fontWeight: 500,
                boxShadow: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {item.label}
            </Button>
          ))}
        </Stack>
      </Stack>

      <Divider sx={{ mb: 3 }} />

      <Box>
        {section === 'cpu' && <SystemCpuRam />}

        {section === 'interfaces' && (
          <SystemInterfaces />
        )}

        {section === 'storages' && <Storages />}
      </Box>
    </Box>
  );
}
