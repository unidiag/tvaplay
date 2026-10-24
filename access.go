package main

import (
	"net/http"
	"net/netip"
	"strings"
	"time"
)

const tttCookieName = "ttt"

// Устанавливает cookie при GET ?ttt=1.
// Важно: cookie не является секретом или токеном.
func setTTTCookie(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		return
	}

	if r.URL.Query().Get("ttt") != "1" {
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     tttCookieName,
		Value:    "1",
		Path:     "/",
		MaxAge:   int((90 * 24 * time.Hour).Seconds()),
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	})
}

// Проверка доступа к телевизионным ресурсам.
func isAllowedTVRequest(r *http.Request) bool {
	ip := getHLSClientIP(r)

	// Существующий whitelist имеет приоритет.
	if isAllowedIP(ip) {
		return true
	}

	// Без cookie дополнительный доступ запрещён.
	cookie, err := r.Cookie(tttCookieName)
	if err != nil || cookie.Value != "1" {
		return false
	}

	// Проверяем корректность и публичность IP.
	addr, err := netip.ParseAddr(ip)
	if err != nil {
		return false
	}

	addr = addr.Unmap()

	if !addr.IsGlobalUnicast() ||
		addr.IsPrivate() ||
		addr.IsLoopback() {
		return false
	}

	// Доступ по cookie только из Беларуси.
	return strings.EqualFold(geoIP(addr.String()), "BY")
}
