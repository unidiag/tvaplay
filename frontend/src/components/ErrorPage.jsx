
export default function ErrorPage({
  ip = '',
  country = '?',
  message = 'Ваша сеть не входит в территорию вещания',
}) {
  return (
    <main className="login-root">
      <div className="login-form">
        <img
          src="/logo192.png"
          alt="TVAPLAY"
          className="login-logo"
        />

        <h1>TVAPLAY</h1>

        <p className="login-description error-page-message">
          {message}
        </p>

        {ip && (
          <p className="error-page-address">
            {ip} ({country || '?'})
          </p>
        )}
      </div>
    </main>
  );
}
