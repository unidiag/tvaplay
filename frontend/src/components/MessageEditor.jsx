import React, { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';

import {
  Box,
  Stack,
  IconButton,
  Tooltip,
  Divider,
  Typography,
} from '@mui/material';

import {
  FormatBold,
  FormatItalic,
  FormatUnderlined,
  FormatStrikethrough,
  FormatListBulleted,
  FormatListNumbered,
  FormatAlignLeft,
  FormatAlignCenter,
  FormatAlignRight,
  FormatClear,
  ImageOutlined,
  Undo,
  Redo,
} from '@mui/icons-material';

const HTML_POLICY = {
  ALLOWED_TAGS: [
    'p', 'div', 'br', 'span',
    'b', 'strong', 'i', 'em',
    'u', 's', 'strike',
    'h2', 'h3',
    'ul', 'ol', 'li',
    'blockquote', 'hr', 'img',
  ],

  ALLOWED_ATTR: [
    'src', 'alt', 'align',
  ],

  ALLOWED_URI_REGEXP: /^https:\/\//i,

  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

export function sanitizeMessageHTML(value) {
  return DOMPurify.sanitize(
    String(value || ''),
    HTML_POLICY
  );
}

export function messagePlainText(value) {
  const container = document.createElement('div');

  container.innerHTML = sanitizeMessageHTML(value);

  container.querySelectorAll('br').forEach(node => {
    node.replaceWith(document.createTextNode('\n'));
  });

  container.querySelectorAll('p, div, li, h2, h3, blockquote')
    .forEach(node => {
      node.appendChild(document.createTextNode('\n'));
    });

  return (container.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function plainTextToHTML(value) {
  const container = document.createElement('div');

  container.textContent = String(value || '');

  return container.innerHTML
    .replace(/\r\n|\r|\n/g, '<br>');
}

export default function MessageEditor({
  value = '',
  onChange,
  disabled = false,
  maxLength = 10000,
}) {
  const editorRef = useRef(null);
  const selectionRef = useRef(null);

  useEffect(() => {
    const editor = editorRef.current;

    if (!editor) return;

    const safeHTML = sanitizeMessageHTML(value);

    // Не заменяем DOM после каждого символа,
    // чтобы курсор не прыгал в начало редактора.
    if (sanitizeMessageHTML(editor.innerHTML) !== safeHTML) {
      editor.innerHTML = safeHTML;
    }
  }, [value]);

  const saveSelection = () => {
    const selection = window.getSelection();

    if (!selection || !selection.rangeCount) return;

    const range = selection.getRangeAt(0);

    if (editorRef.current?.contains(range.commonAncestorContainer)) {
      selectionRef.current = range.cloneRange();
    }
  };

  const restoreSelection = () => {
    const editor = editorRef.current;

    if (!editor) return;

    editor.focus();

    const selection = window.getSelection();

    if (!selection) return;

    const saved = selectionRef.current;

    if (saved && editor.contains(saved.commonAncestorContainer)) {
      selection.removeAllRanges();
      selection.addRange(saved);
    } else {
      const range = document.createRange();

      range.selectNodeContents(editor);
      range.collapse(false);

      selection.removeAllRanges();
      selection.addRange(range);
    }
  };

  const emitChange = () => {
    if (!editorRef.current) return;

    const html = sanitizeMessageHTML(
      editorRef.current.innerHTML
    );

    onChange?.(html);

    saveSelection();
  };

  const execute = (command, argument = null) => {
    if (disabled) return;

    restoreSelection();

    document.execCommand(
      'styleWithCSS',
      false,
      false
    );

    document.execCommand(
      command,
      false,
      argument
    );

    emitChange();
  };

  const insertImage = () => {
    if (disabled) return;

    saveSelection();

    const input = window.prompt(
      'Enter image HTTPS URL:',
      'https://'
    );

    if (!input) return;

    let url;

    try {
      url = new URL(input.trim());

      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password
      ) {
        throw new Error('Invalid URL');
      }
    } catch {
      window.alert('Only valid HTTPS URLs are allowed.');
      return;
    }

    const img = document.createElement('img');

    img.setAttribute('src', url.href);
    img.setAttribute('alt', '');

    execute('insertHTML', img.outerHTML);
  };

  const handlePaste = event => {
    event.preventDefault();

    if (disabled) return;

    const html = event.clipboardData.getData('text/html');
    const text = event.clipboardData.getData('text/plain');

    execute(
      'insertHTML',
      html
        ? sanitizeMessageHTML(html)
        : plainTextToHTML(text)
    );
  };

  const tool = (title, Icon, command, argument = null) => (
    <Tooltip title={title}>
      <span>
        <IconButton
          size="small"
          disabled={disabled}
          onMouseDown={event => event.preventDefault()}
          onClick={() => execute(command, argument)}
        >
          <Icon fontSize="small" />
        </IconButton>
      </span>
    </Tooltip>
  );

  const htmlLength = Array.from(value || '').length;

  return (
    <Box>
      <Typography
        variant="body2"
        color="text.secondary"
        sx={{ mb: 0.75 }}
      >
        Message
      </Typography>

      <Box
        sx={{
          border: 1,
          borderColor: htmlLength > maxLength
            ? 'error.main'
            : 'divider',
          borderRadius: 1,
          overflow: 'hidden',
        }}
      >
        <Stack
          direction="row"
          sx={{
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 0.25,
            p: 0.5,
            bgcolor: 'action.hover',
          }}
        >
          {tool('Undo', Undo, 'undo')}
          {tool('Redo', Redo, 'redo')}

          <Divider orientation="vertical" flexItem />

          {tool('Bold', FormatBold, 'bold')}
          {tool('Italic', FormatItalic, 'italic')}
          {tool('Underline', FormatUnderlined, 'underline')}

          {tool(
            'Strikethrough',
            FormatStrikethrough,
            'strikeThrough'
          )}

          <Divider orientation="vertical" flexItem />

          {tool(
            'Bulleted list',
            FormatListBulleted,
            'insertUnorderedList'
          )}

          {tool(
            'Numbered list',
            FormatListNumbered,
            'insertOrderedList'
          )}

          <Divider orientation="vertical" flexItem />

          {tool('Align left', FormatAlignLeft, 'justifyLeft')}
          {tool('Align center', FormatAlignCenter, 'justifyCenter')}
          {tool('Align right', FormatAlignRight, 'justifyRight')}

          <Divider orientation="vertical" flexItem />

          <Tooltip title="Insert image by URL">
            <span>
              <IconButton
                size="small"
                disabled={disabled}
                onMouseDown={event => event.preventDefault()}
                onClick={insertImage}
              >
                <ImageOutlined fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>

          {tool('Clear formatting', FormatClear, 'removeFormat')}
        </Stack>

        <Divider />

        <Box
          ref={editorRef}
          contentEditable={!disabled}
          suppressContentEditableWarning
          role="textbox"
          aria-label="Message"
          aria-multiline="true"
          onInput={emitChange}
          onMouseUp={saveSelection}
          onKeyUp={saveSelection}
          onBlur={saveSelection}
          onPaste={handlePaste}
          onDrop={event => event.preventDefault()}
          sx={{
            minHeight: 220,
            maxHeight: 480,
            overflowY: 'auto',
            p: 2,
            outline: 'none',
            fontSize: '1rem',
            lineHeight: 1.5,
            overflowWrap: 'anywhere',

            opacity: disabled ? 0.6 : 1,

            '& img': {
              maxWidth: '100%',
              maxHeight: 320,
              height: 'auto',
            },

            '& p': {
              my: 0.75,
            },

            '& ul, & ol': {
              pl: 4,
            },
          }}
        />
      </Box>

      <Typography
        variant="caption"
        color={
          htmlLength > maxLength
            ? 'error'
            : 'text.secondary'
        }
      >
        HTML content: {htmlLength} / {maxLength}
      </Typography>
    </Box>
  );
}