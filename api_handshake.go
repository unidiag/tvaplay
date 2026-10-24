package main

import (
	"net"
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

	return out
}
