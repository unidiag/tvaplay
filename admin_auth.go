package main

import (
	"log"
	"net/http"
	"strings"
	"time"
)

const adminCookieName = "tvaplay_admin"

func adminAuthUser(r *http.Request) bool {
	cookie, err := r.Cookie(adminCookieName)
	if err != nil || cookie.Value == "" {
		return false
	}

	req := r.Clone(r.Context())
	req.Header = r.Header.Clone()
	req.Header.Set(
		"Authorization",
		"Bearer "+cookie.Value,
	)

	user, err := getAuthUser(req)

	return err == nil && user != nil && user.Status >= 8
}

// Обмен существующего access JWT на HttpOnly cookie.
// POST /admin/session
func adminSession(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Запрещаем запросы с другого Origin.
	if origin := r.Header.Get("Origin"); origin != "" {
		if !sameOrigin(r, origin) {
			log.Printf(
				"[ADMIN] origin mismatch: origin=%q host=%q proto=%q tls=%v",
				origin,
				r.Host,
				r.Header.Get("X-Forwarded-Proto"),
				r.TLS != nil,
			)

			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
	}

	user, err := getAuthUser(r)
	if err != nil || user == nil {
		log.Printf("[ADMIN] invalid JWT: %v", err)

		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	if user.Status < 8 {
		log.Printf(
			"[ADMIN] access denied: user_id=%d status=%d",
			user.ID,
			user.Status,
		)

		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	log.Printf("[ADMIN] access granted: user_id=%d", user.ID)

	parts := strings.Fields(r.Header.Get("Authorization"))
	if len(parts) != 2 {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	claims, err := parseAccessToken(parts[1])
	if err != nil || claims.ExpiresAt == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	secure := r.TLS != nil ||
		r.Header.Get("X-Forwarded-Proto") == "https"

	http.SetCookie(w, &http.Cookie{
		Name:     adminCookieName,
		Value:    parts[1],
		Path:     "/admin",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
		Expires:  claims.ExpiresAt.Time,
	})

	w.WriteHeader(http.StatusNoContent)
}

func sameOrigin(r *http.Request, origin string) bool {
	scheme := "http"

	if r.TLS != nil {
		scheme = "https"
	} else if r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}

	expected := scheme + "://" + r.Host

	return origin == expected
}

// Максимальное время действия cookie
// определяется временем жизни JWT, не продлевается отдельно.
var _ = time.Minute

func serveAdminBootstrap(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'")

	_, _ = w.Write([]byte(`<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TVAPLAY Admin</title>
</head>
<body>
<p id="message">Проверка авторизации...</p>

<script>
(async function () {
  const message = document.getElementById("message");
  const accessKey = "tvaplay_access_token";
  const refreshKey = "tvaplay_refresh_token";

  async function createSession(token) {
    return fetch("/admin/session", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token
      },
      credentials: "same-origin"
    });
  }

  try {
    let access = localStorage.getItem(accessKey);
    let response = access
      ? await createSession(access)
      : null;

    if (!response || response.status === 401) {
      const refresh = localStorage.getItem(refreshKey);

      if (refresh) {
        const result = await fetch("/api", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            op: "authRefresh",
            refresh_token: refresh
          })
        });

        const json = await result.json();
        const data = json.data || {};

        if (data.status === "OK" && data.access_token) {
          access = data.access_token;
          localStorage.setItem(accessKey, access);
          response = await createSession(access);
        }
      }
    }

    if (response && response.ok) {
      location.replace("/admin");
      return;
    }

    if (response && response.status === 403) {
      message.textContent = "Доступ запрещён. Требуется статус администратора.";
    } else {
      message.textContent = "Требуется авторизация в TVAPLAY.";
    }
  } catch (err) {
    message.textContent = "Ошибка проверки авторизации.";
  }
})();
</script>
</body>
</html>`))
}
