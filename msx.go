package main

import (
	"encoding/json"
	"net/http"
)

func registerMSX() {
	http.HandleFunc("/msx/start.json", msxStart)
	http.HandleFunc("/msx/app.json", msxApp)
}

func msxStart(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	json.NewEncoder(w).Encode(map[string]any{
		"name":      APPNAME,
		"version":   VERSION,
		"parameter": "content:{PREFIX}{SERVER}/msx/app.json",
	})
}

func msxApp(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	proto := "http"
	if r.TLS != nil ||
		r.Header.Get("X-Forwarded-Proto") == "https" {
		proto = "https"
	}

	url := proto + "://" + r.Host + "/"
	action := "link:replace:" + url

	json.NewEncoder(w).Encode(map[string]any{
		"type":     "pages",
		"headline": APPNAME,

		// Отключаем восстановление и кеширование
		// MSX-контента после возврата из link action.
		"restore": false,
		"cache":   false,
		"reuse":   false,

		// Автоматический запуск при старте.
		"action": action,

		"pages": []any{
			map[string]any{
				"items": []any{
					map[string]any{
						"type":   "default",
						"layout": "0,0,12,6",
						"label":  "TVAPLAY",
						"text":   "Press OK to start TVAPLAY",

						// Ручной запуск, если автоматический
						// переход не выполнился.
						"action": action,
					},
				},
			},
		},
	})
}
