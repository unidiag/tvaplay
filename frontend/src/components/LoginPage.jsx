
import { useEffect, useState } from 'react';

const PHONE_PREFIXES = ['25', '29', '33', '44'];
const CONFIRMATION_CODE = '8888';
const RETRY_TIMEOUT = 90;

const formatPhone = (value) => {
  let digits = value.replace(/\D/g, '');

  if (!digits) return '';

  if (digits.startsWith('375')) {
    digits = '80' + digits.slice(3);
  } else if (digits.startsWith('0')) {
    digits = '8' + digits;
  }

  if (!digits.startsWith('80')) {
    digits = '80' + digits.replace(/^8?0?/, '');
  }

  digits = digits.slice(0, 11);

  let result = digits.slice(0, 1);

  if (digits.length > 1) {
    result += '-' + digits.slice(1, 4);
  }

  if (digits.length > 4) {
    result += '-' + digits.slice(4, 7);
  }

  if (digits.length > 7) {
    result += '-' + digits.slice(7, 9);
  }

  if (digits.length > 9) {
    result += '-' + digits.slice(9, 11);
  }

  return result;
};

const isValidPhone = (phone) => {
  const digits = phone.replace(/\D/g, '');

  return (
    /^80(25|29|33|44)\d{7}$/.test(digits) &&
    PHONE_PREFIXES.includes(digits.slice(2, 4))
  );
};

export default function LoginPage({ onLogin }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [error, setError] = useState('');

  // Время окончания блокировки.
  const [retryUntil, setRetryUntil] = useState(null);
  const [secondsLeft, setSecondsLeft] = useState(0);

  const isBlocked = retryUntil !== null;

  // Проверка кода мобильного оператора.
  const operatorCode = phone
    .replace(/\D/g, '')
    .slice(2, 4);

  const invalidOperator =
    operatorCode.length === 2 &&
    !PHONE_PREFIXES.includes(operatorCode);

  // Обратный отсчёт после неверного SMS-кода.
  useEffect(() => {
    if (retryUntil === null) return;

    const updateTimer = () => {
      const remaining = Math.max(
        0,
        Math.ceil((retryUntil - Date.now()) / 1000)
      );

      setSecondsLeft(remaining);

      if (remaining === 0) {
        setRetryUntil(null);
        setCodeSent(false);
        setCode('');
        setError('');
      }
    };

    updateTimer();

    const interval = setInterval(updateTimer, 250);

    return () => clearInterval(interval);
  }, [retryUntil]);

  const handlePhoneChange = (event) => {
    setPhone(formatPhone(event.target.value));
    setError('');
  };

  const handleSendCode = (event) => {
    event.preventDefault();

    if (codeSent || isBlocked) return;

    if (!isValidPhone(phone)) {
      setError('Введите корректный номер телефона');
      return;
    }

    // Позже здесь будет запрос API для отправки SMS.
    setCode('');
    setCodeSent(true);
    setError('');
  };


    const handleCodeChange = (event) => {
    const value = event.target.value
        .replace(/\D/g, '')
        .slice(0, 4);

    setCode(value);

    if (value.length !== 4) return;

    if (value === CONFIRMATION_CODE) {
        onLogin({ phone, code: value });
        return;
    }

    // Если таймер уже запущен, не перезапускаем его.
    if (retryUntil !== null) return;

    setError('Неверный код подтверждения.');
    setSecondsLeft(RETRY_TIMEOUT);
    setRetryUntil(Date.now() + RETRY_TIMEOUT * 1000);
    };


  return (
    <div className="login-root">
      <form
        className="login-form"
        onSubmit={handleSendCode}
      >
        <img
          src="/logo192.png"
          alt="TVAPLAY"
          className="login-logo"
        />

        <h1>TVAPLAY</h1>

        <p className="login-description">
          Введите номер телефона для входа
        </p>

        <input
          type="tel"
          inputMode="numeric"
          autoComplete="tel"
          placeholder="8-029-123-45-67"
          value={phone}
          onChange={handlePhoneChange}
          disabled={codeSent}
          className={`login-input ${
            invalidOperator ? 'login-input-error' : ''
          }`}
          aria-label="Номер телефона"
          aria-invalid={invalidOperator}
          autoFocus
        />

        {invalidOperator && (
          <p className="login-error">
            Некорректный код оператора
          </p>
        )}

        {!codeSent ? (
          <button
            type="submit"
            className="login-button"
            disabled={!isValidPhone(phone)}
          >
            Отправить код
          </button>
        ) : (
          <>
            <p className="login-code-hint">
              Введите код из SMS
            </p>


            <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={4}
            placeholder="0000"
            value={code}
            onChange={handleCodeChange}
            className={`login-input login-code ${
                isBlocked ? 'login-input-error' : ''
            }`}
            aria-label="Код подтверждения"
            aria-invalid={isBlocked}
            autoFocus
            />


            {isBlocked && (
            <p className="login-retry-message" role="status">
                Неверный код подтверждения.
                <span>
                Вы можете повторить через{' '}
                <strong>{secondsLeft} сек.</strong>
                </span>
            </p>
            )}
          </>
        )}

        {error && !isBlocked && (
          <p className="login-error">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
