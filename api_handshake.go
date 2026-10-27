package main

import (
	"net"
	"time"
)

func apiGuestHandshake(ctx *ApiCtx) map[string]any {
	out := ctx.Out

	// Используем тот же механизм определения IP,
	// что и в HLS-прокси.
	ip := getHLSClientIP(ctx.R)

	country := "?"

	// Не обращаемся к GeoIP с некорректным IP.
	if net.ParseIP(ip) != nil {
		country = geoIP(ip)
		if country == "" {
			country = "?"
		}
	}

	out["ip"] = ip
	out["country"] = country
	out["allowed"] = isAllowedIP(ip)
	out["time"] = time.Now().Format("2006-01-02 15:04:05")
	// Версия текущей сборки TVAPLAY
	out["version"] = VERSION

	return out
}
