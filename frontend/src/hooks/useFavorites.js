
import { useEffect, useRef } from 'react';

const LONG_PRESS_MS = 700;

const isYellowKey = (event) =>
  event.key === 'Yellow' ||
  event.key === 'ColorF2' ||
  event.key === 'F7' ||
  event.keyCode === 405;

export default function useFavorites({
  onShortPress,
  onLongPress,
}) {
  const callbacksRef = useRef({
    onShortPress,
    onLongPress,
  });

  useEffect(() => {
    callbacksRef.current = {
      onShortPress,
      onLongPress,
    };
  }, [onShortPress, onLongPress]);

  useEffect(() => {
    let timer = null;
    let pressed = false;
    let longPressed = false;

    const reset = () => {
      clearTimeout(timer);
      timer = null;
      pressed = false;
      longPressed = false;
    };

    const keydown = (event) => {
      if (!isYellowKey(event)) return;

      if (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(
          document.activeElement?.tagName
        )
      ) return;

      event.preventDefault();

      if (pressed || event.repeat) return;

      pressed = true;
      longPressed = false;

      timer = setTimeout(() => {
        if (!pressed) return;

        longPressed = true;
        callbacksRef.current.onLongPress?.();
      }, LONG_PRESS_MS);
    };

    const keyup = (event) => {
      if (!isYellowKey(event)) return;

      event.preventDefault();

      if (!pressed) return;

      const wasLongPressed = longPressed;

      reset();

      if (!wasLongPressed) {
        callbacksRef.current.onShortPress?.();
      }
    };

    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', reset);

    return () => {
      reset();

      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('blur', reset);
    };
  }, []);
}
