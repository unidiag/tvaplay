package main

import (
	"net/http"
	"net/netip"
	"strings"
)

const tttCookieName = "ttt"

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
