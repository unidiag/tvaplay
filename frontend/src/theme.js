
import { createTheme } from '@mui/material/styles';

const theme = createTheme({
  palette: {
    mode: 'dark',

    primary: {
      main: '#7ea9d6',
      light: '#a3c4e5',
      dark: '#527fae',
      contrastText: '#101923',
    },

    secondary: {
      main: '#8299b5',
    },

    background: {
      default: '#101923',
      paper: '#192534',
    },

    text: {
      primary: '#e4ebf4',
      secondary: '#91a3b8',
      disabled: '#607286',
    },

    divider: '#2c3b4d',

    success: {
      main: '#66b8a1',
    },

    warning: {
      main: '#e3ad65',
    },

    error: {
      main: '#d97982',
    },

    info: {
      main: '#7ea9d6',
    },
  },

  shape: {
    borderRadius: 8,
  },

  typography: {
    fontFamily: 'Roboto, Arial, sans-serif',
    h5: {
      fontWeight: 600,
    },
    h6: {
      fontWeight: 600,
    },
  },

  components: {
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: '#101923',
        },
      },
    },

    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: '#152131',
          backgroundImage: 'none',
          borderBottom: '1px solid #2c3b4d',
          boxShadow: 'none',
        },
      },
    },

    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: '1px solid #2c3b4d',
        },
      },
    },

    MuiCard: {
      styleOverrides: {
        root: {
          backgroundColor: '#192534',
          backgroundImage: 'none',
          border: '1px solid #2c3b4d',
          boxShadow: 'none',
        },
      },
    },

    MuiTableHead: {
      styleOverrides: {
        root: {
          backgroundColor: '#202e40',
        },
      },
    },

    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottom: '1px solid #2c3b4d',
        },
        head: {
          color: '#aebed0',
          fontWeight: 600,
        },
      },
    },

    MuiTableRow: {
      styleOverrides: {
        root: {
          '&.MuiTableRow-hover:hover': {
            backgroundColor: '#25364a',
          },
        },
      },
    },

    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 500,
          boxShadow: 'none',
        },
        contained: {
          '&:hover': {
            boxShadow: 'none',
          },
        },
      },
    },

    MuiTextField: {
      defaultProps: {
        variant: 'outlined',
        size: 'small',
      },
    },

    MuiOutlinedInput: {
      styleOverrides: {
        root: {
          backgroundColor: '#14202d',
          '&:hover .MuiOutlinedInput-notchedOutline': {
            borderColor: '#527fae',
          },
        },
      },
    },

    MuiTabs: {
      styleOverrides: {
        indicator: {
          height: 3,
          borderRadius: '3px 3px 0 0',
        },
      },
    },

    MuiTab: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 500,
          minHeight: 64,
        },
      },
    },
  },
});

export default theme;
