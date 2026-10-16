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
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	proto := "http"

	if r.TLS != nil ||
		r.Header.Get("X-Forwarded-Proto") == "https" {
		proto = "https"
	}

	url := proto + "://" + r.Host + "/"

	json.NewEncoder(w).Encode(map[string]any{
		"type":   "pages",
		"action": "link:replace:" + url,
		"pages": []any{
			map[string]any{
				"items": []any{
					map[string]any{
						"type":   "default",
						"layout": "0,0,12,6",
						"label":  "tvaplay",
						"text":   "Loading tvaplay...",
					},
				},
			},
		},
	})
}
