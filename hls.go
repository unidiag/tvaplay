package main

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"path"
	"strings"
	"time"
)

// Возвращает IP клиента.
//
// X-Real-IP используем только если запрос пришёл
// от доверенного локального Nginx.
//
// Go-сервер должен слушать только 127.0.0.1:8008,
// чтобы внешние клиенты не могли самостоятельно
// отправлять поддельный X-Real-IP.
func getHLSClientIP(r *http.Request) string {
	remote, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return ""
	}

	peer := remote.Addr().Unmap()

	if peer.IsLoopback() {
		headerIP := strings.TrimSpace(
			r.Header.Get("X-Real-IP"),
		)

		if headerIP != "" {
			ip, err := netip.ParseAddr(headerIP)
			if err != nil {
				return ""
			}

			return ip.Unmap().String()
		}
	}

	return peer.String()
}

// Страница ошибки доступа.
func writeHLSForbidden(w http.ResponseWriter) {
	w.Header().Set(
		"Content-Type",
		"text/html; charset=utf-8",
	)
	w.Header().Set("Cache-Control", "no-store")

	w.WriteHeader(http.StatusForbidden)

	fmt.Fprintf(
		w,
		"<h2>403 Forbidden</h2>tvaplay ver.%v\n",
		VERSION,
	)
}

// Создаёт reverse proxy для одного HLS-источника.
func newHLSProxy(
	route string,
	target *url.URL,
) *httputil.ReverseProxy {

	proxy := httputil.NewSingleHostReverseProxy(target)

	proxy.Transport = &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout:   5 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   50,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: 15 * time.Second,
		DisableCompression:    true,
	}

	proxy.ModifyResponse = func(resp *http.Response) error {

		// Удаляем CORS-заголовки upstream.
		resp.Header.Del("Access-Control-Allow-Origin")
		resp.Header.Del("Access-Control-Allow-Credentials")
		resp.Header.Del("Access-Control-Allow-Methods")
		resp.Header.Del("Access-Control-Allow-Headers")
		resp.Header.Del("Access-Control-Max-Age")

		// ------------------------------------
		// Обработка 404
		// ------------------------------------
		if resp.StatusCode == http.StatusNotFound {

			resp.Body.Close()

			body := []byte(
				"<h2>404 Not Found</h2>tvaplay ver." +
					fmt.Sprint(VERSION) + "\n",
			)

			resp.Body = io.NopCloser(
				bytes.NewReader(body),
			)

			resp.ContentLength = int64(len(body))
			resp.Header = make(http.Header)

			resp.Header.Set(
				"Content-Type",
				"text/html; charset=utf-8",
			)

			resp.Header.Set(
				"Content-Length",
				fmt.Sprint(len(body)),
			)

			resp.Header.Set(
				"Cache-Control",
				"no-store",
			)

			return nil
		}

		if resp.StatusCode != http.StatusOK {
			return nil
		}

		// ------------------------------------
		// Переписываем только .m3u8
		// ------------------------------------
		if !strings.EqualFold(
			path.Ext(resp.Request.URL.Path),
			".m3u8",
		) {
			return nil
		}

		const maxPlaylistSize = 4 << 20

		data, err := io.ReadAll(
			io.LimitReader(resp.Body, maxPlaylistSize+1),
		)

		resp.Body.Close()

		if err != nil {
			return err
		}

		if len(data) > maxPlaylistSize {
			return fmt.Errorf("HLS playlist too large")
		}

		// ------------------------------------
		// Заменяем внутренние адреса
		// на соответствующий публичный маршрут.
		// ------------------------------------
		oldBase := target.Scheme + "://" + target.Host
		newBase := "/" + route

		data = bytes.ReplaceAll(
			data,
			[]byte(oldBase+"/"),
			[]byte(newBase+"/"),
		)

		// Astra может отдавать адреса с host=0.
		data = bytes.ReplaceAll(
			data,
			[]byte("http://0:8000/"),
			[]byte(newBase+"/"),
		)

		resp.Body = io.NopCloser(
			bytes.NewReader(data),
		)

		resp.ContentLength = int64(len(data))

		resp.Header.Set(
			"Content-Length",
			fmt.Sprint(len(data)),
		)

		resp.Header.Del("ETag")
		resp.Header.Del("Content-MD5")
		resp.Header.Del("Content-Encoding")

		resp.Header.Set(
			"Content-Type",
			"application/vnd.apple.mpegurl",
		)

		return nil
	}

	proxy.ErrorHandler = func(
		w http.ResponseWriter,
		r *http.Request,
		err error,
	) {
		log.Printf(
			"HLS proxy [%s] error: %v",
			route,
			err,
		)

		http.Error(
			w,
			"HLS source unavailable",
			http.StatusBadGateway,
		)
	}

	return proxy
}

// Регистрирует обработчик одного HLS-маршрута.
func registerHLSRoute(
	route string,
	address string,
) {
	target, err := url.Parse("http://" + address)
	if err != nil {
		log.Fatalf(
			"Invalid HLS upstream [%s]: %v",
			route,
			err,
		)
	}

	if target.Host == "" || target.Port() == "" {
		log.Fatalf(
			"Invalid HLS upstream [%s]: %s",
			route,
			address,
		)
	}

	proxy := newHLSProxy(route, target)

	prefix := "/" + route + "/"

	http.Handle(prefix, http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {

			setHLSCORS(w, r)

			// --------------------------------
			// CORS Preflight
			// --------------------------------
			if r.Method == http.MethodOptions {
				origin := r.Header.Get("Origin")

				if origin != "http://127.0.0.1:3000" &&
					origin != "http://localhost:3000" {

					http.Error(
						w,
						"Forbidden",
						http.StatusForbidden,
					)
					return
				}

				w.WriteHeader(http.StatusNoContent)
				return
			}

			// --------------------------------
			// Разрешённые HTTP-методы
			// --------------------------------
			if r.Method != http.MethodGet &&
				r.Method != http.MethodHead {

				w.Header().Set(
					"Allow",
					"GET, HEAD, OPTIONS",
				)

				http.Error(
					w,
					"Method not allowed",
					http.StatusMethodNotAllowed,
				)
				return
			}

			// --------------------------------
			// Проверка доступа
			// --------------------------------
			if !isAllowedTVRequest(r) {
				writeHLSForbidden(w)
				return
			}

			// --------------------------------
			// Убираем префикс маршрута.
			//
			// /hls2/s1490/index.m3u8
			// -> /s1490/index.m3u8
			// --------------------------------
			r.URL.Path = strings.TrimPrefix(
				r.URL.Path,
				"/"+route,
			)

			r.URL.RawPath = ""
			r.Host = target.Host

			// --------------------------------
			// Проксируем запрос
			// --------------------------------
			proxy.ServeHTTP(w, r)
		},
	))

	log.Printf(
		"HLS route /%s/ -> %s",
		route,
		target.String(),
	)
}

// Регистрирует все HLS-источники из config.go.
func registerHLS() {
	for route, address := range HLSUpstreams {
		registerHLSRoute(route, address)
	}
}
