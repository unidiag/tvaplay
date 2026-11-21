import React, { useMemo, useState } from 'react';

import {
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  List,
  ListItemButton,
  ListItemText,
  TextField,
  Typography,
} from '@mui/material';

import {
  Close as CloseIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import { Star as StarIcon } from '@mui/icons-material';

import {
  getCountries,
  getCountryCallingCode,
} from 'libphonenumber-js';

import phoneMetadata from 'libphonenumber-js/metadata.max.json';

// Custom mobile-number rules.


const OVERRIDES = {
  // Belarus
  BY: String.raw`^\+375(25|29|33|44)[0-9]{7}$`,

  // Russia
  RU: String.raw`^\+7(9[0-9]{2})[0-9]{7}$`,

  // Latvia
  LV: String.raw`^\+371(2[0-9])[0-9]{6}$`,

  // Lithuania
  LT: String.raw`^\+370(6[0-9])[0-9]{6}$`,

  // Estonia
  EE: String.raw`^\+372(5[0-9])[0-9]{5,6}$`,

  // Poland
  PL: String.raw`^\+48(45|5[0137]|6[069]|7[2389]|88)[0-9]{7}$`,

  // Georgia
  GE: String.raw`^\+995(5[0-9])[0-9]{7}$`,

  // Armenia
  AM: String.raw`^\+374(33|4[1349]|55|77|88|9[13456789])[0-9]{6}$`,

  // Tajikistan
  TJ: String.raw`^\+992(50|9[0-9])[0-9]{7}$`,

  // Moldova
  MD: String.raw`^\+373(6[0-9]|7[0-9])[0-9]{6}$`,

  // Kazakhstan
  KZ: String.raw`^\+7(70[0125678]|747|77[15678])[0-9]{7}$`,

  // Ukraine
  UA: String.raw`^\+380(39|50|6[36-8]|7[1-357]|9[1-9])[0-9]{7}$`,

  // Turkey
  TR: String.raw`^\+90(50[1567]|53[0-9]|54[0-9]|55[1-59])[0-9]{7}$`,

  // Egypt
  EG: String.raw`^\+20(1[0125])[0-9]{8}$`,

  // Albania
  AL: String.raw`^\+355(6[789])[0-9]{7}$`,

  // Algeria
  DZ: String.raw`^\+213([567][0-9])[0-9]{7}$`,

  // Turkmenistan
  TM: String.raw`^\+993(6[0-9]|7[12])[0-9]{6}$`,

  // Kyrgyzstan
  KG: String.raw`^\+996(50|51|5[4-7]|60|70|75|77|99)[0-9]{7}$`,

  // Uzbekistan
  UZ: String.raw`^\+998(20|33|50|70|77|88|9[013-59])[0-9]{7}$`,

  // Italy
  IT: String.raw`^\+39(3[0-9]{2})[0-9]{6,7}$`,

  // Portugal
  PT: String.raw`^\+351(9[1236])[0-9]{7}$`,

  // Germany
  DE: String.raw`^\+49(1[567])[0-9]{8,9}$`,

  // France
  FR: String.raw`^\+33([67])[0-9]{8}$`,

  // Spain
  ES: String.raw`^\+34(6[0-9]|7[1-9])[0-9]{7}$`,

  // United Kingdom
  GB: String.raw`^\+44(7[1-57-9])[0-9]{8}$`,

  // Switzerland
  CH: String.raw`^\+41(7[5-9])[0-9]{7}$`,

  // Sweden
  SE: String.raw`^\+46(70|72|73|76|79)[0-9]{7}$`,

  // Netherlands
  NL: String.raw`^\+31(6)[0-9]{8}$`,

  // Argentina
  AR: String.raw`^\+54(9)[0-9]{10}$`,

  // Peru
  PE: String.raw`^\+51(9[0-9])[0-9]{7}$`,

  // Colombia
  CO: String.raw`^\+57(3[0-9]{2})[0-9]{7}$`,

  // Mexico
  MX: String.raw`^\+52([2-9][0-9])[0-9]{8}$`,

  // Venezuela
  VE: String.raw`^\+58(412|414|416|422|424|426)[0-9]{7}$`,

  // New Zealand
  NZ: String.raw`^\+64(20|21|22|27|28|29)[0-9]{6,8}$`,


  // Australia
  AU: String.raw`^\+61(4[0-9])[0-9]{7}$`,

  // Austria
  AT: String.raw`^\+43(650|660|66[457]|67[0678]|68[01689]|69[089])[0-9]{7,9}$`,

  // Azerbaijan
  AZ: String.raw`^\+994(10|40|44|50|51|55|60|70|77|99)[0-9]{7}$`,

  // Mongolia
  MN: String.raw`^\+976(26|50|55|60|66|69|80|8[356-9]|9[013-9])[0-9]{6}$`,

  // Greece
  GR: String.raw`^\+30(68[5-9]|69[013-5789])[0-9]{7}$`,

  // Chile
  CL: String.raw`^\+56(9)[0-9]{8}$`,

  // Canada
  CA: String.raw`^\+1([2-9][0-9]{2})[2-9][0-9]{6}$`,

  // Hungary
  HU: String.raw`^\+36(20|30|31|50|70)[0-9]{7}$`,

  // Slovakia
  SK: String.raw`^\+421(9(?:0[1-9]|1[0-9]|4[0-9]|5[0-9]))[0-9]{6}$`,

  // Czech Republic
  CZ: String.raw`^\+420(60[1-8]|7[2379][0-9])[0-9]{6}$`,


};



const displayNames =
  typeof Intl !== 'undefined' &&
  typeof Intl.DisplayNames === 'function'
    ? new Intl.DisplayNames(['en'], { type: 'region' })
    : null;

function countryName(code) {
  const name = displayNames ? displayNames.of(code) : code;
  return name && name !== code ? name : code;
}

function countryFlag(code) {
  if (!/^[A-Z]{2}$/.test(code)) return '🌐';

  return String.fromCodePoint(
    ...code.split('').map(
      letter => letter.charCodeAt(0) + 127397
    )
  );
}


// Extract mobile-specific metadata.
function mobileMetadata(code) {
  const country = phoneMetadata.countries[code];

  if (!country) return null;

  // Metadata v4:
  // [11]    - number types
  // [11][1] - MOBILE
  // [0]     - national pattern
  // [1]     - possible national lengths

  const types = country[11];

  if (!Array.isArray(types)) return null;

  const mobile = types[1];

  if (!Array.isArray(mobile)) return null;

  const pattern = mobile[0];

  if (typeof pattern !== 'string' || !pattern) {
    return null;
  }

  const lengths = (
    Array.isArray(mobile[1]) && mobile[1].length
      ? mobile[1]
      : country[3]
  );

  if (!Array.isArray(lengths)) return null;

  return {
    pattern,
    lengths: [...new Set(lengths)]
      .filter(Number.isInteger)
      .sort((a, b) => a - b),
  };
}


function countryRegex(code) {
  if (OVERRIDES[code]) {
    return OVERRIDES[code];
  }

  const callingCode = getCountryCallingCode(code);
  const mobile = mobileMetadata(code);

  if (!mobile || !mobile.pattern) {
    return null;
  }

  // Use the original mobile number pattern.
  // Go regexp (RE2) does not support lookahead (?=...).
  const regex =
    String.raw`^\+` +
    callingCode +
    '(?:' + mobile.pattern + ')$';

  try {
    new RegExp(regex);
    return regex;
  } catch (_) {
    return null;
  }
}


export default function TemplatePhones({
  onSelect,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const countries = useMemo(() => {
    return getCountries()
      .map(code => ({
        code,
        name: countryName(code),
        flag: countryFlag(code),
        callingCode: getCountryCallingCode(code),
        regex: countryRegex(code),
        verified: Object.prototype.hasOwnProperty.call(OVERRIDES, code),
      }))
      .filter(item => item.regex)
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name, 'en') ||
          a.code.localeCompare(b.code)
      );
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLocaleLowerCase('en');

    if (!q) return countries;

    return countries.filter(
      ({ name, code, callingCode }) =>
        name.toLocaleLowerCase('en').includes(q) ||
        code.toLowerCase().includes(q) ||
        ('+' + callingCode).includes(q)
    );
  }, [countries, search]);

  const close = () => {
    setOpen(false);
    setSearch('');
  };

  const choose = item => {
    onSelect(item.regex);
    close();
  };

  return (
    <>
      <Button
        variant="text"
        size="small"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title="Phone number templates"
        aria-label="Phone number templates"
        sx={{
          flexShrink: 0,
          minWidth: 28,
          p: 0.5,
        }}
      >
        <StarIcon sx={{ fontSize: 18 }} />
      </Button>

      <Dialog
        open={open}
        onClose={close}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            pr: 1,
          }}
        >
          Mobile phone templates

          <IconButton
            onClick={close}
            size="small"
            aria-label="Close dialog"
          >
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>

        <Box sx={{ px: 3, pb: 1.5 }}>
          <TextField
            fullWidth
            size="small"
            placeholder="Search country or calling code"
            value={search}
            onChange={event =>
              setSearch(event.target.value)
            }
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              },
            }}
          />

<Typography
  variant="caption"
  color="text.secondary"
  sx={{ display: 'block', mt: 1 }}
>
  ★ Custom verified mobile templates
</Typography>

        </Box>

        <DialogContent
          dividers
          sx={{
            pt: 0,
            px: 1,
            maxHeight: 'min(65vh, 560px)',
          }}
        >
          <List disablePadding>
            {filtered.map(item => (
              <ListItemButton
                key={item.code}
                onClick={() => choose(item)}
              >
                <Box
                  component="span"
                  aria-hidden="true"
                  sx={{
                    fontSize: 23,
                    mr: 1.5,
                    width: 32,
                    textAlign: 'center',
                  }}
                >
                  {item.flag}
                </Box>

                <ListItemText
                  primary={item.name}
                  secondary={`+${item.callingCode} · ${item.code}`}
                  slotProps={{
                    primary: { variant: 'body2' },
                    secondary: { variant: 'caption' },
                  }}
                />

                {item.verified && (
                  <StarIcon
                    titleAccess="Custom mobile regex"
                    sx={{
                      ml: 1,
                      fontSize: 18,
                      color: 'warning.main',
                      flexShrink: 0,
                    }}
                  />
                )}
              </ListItemButton>
            ))}
          </List>

          {filtered.length === 0 && (
            <Typography
              sx={{ py: 3, textAlign: 'center' }}
              color="text.secondary"
              variant="body2"
            >
              No mobile templates found
            </Typography>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
