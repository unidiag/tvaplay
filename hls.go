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

	// Доверяем X-Real-IP только от локального прокси.
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

func registerHLS() {
	target, err := url.Parse("http://127.0.0.1:5000")
	if err != nil {
		log.Fatal(err)
	}

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

		// ------------------------------------
		// Собственная страница ошибки 404
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
		if err != nil {
			return err
		}

		if len(data) > maxPlaylistSize {
			return fmt.Errorf("HLS playlist too large")
		}

		resp.Body.Close()

		// Заменяем внутренние адреса.
		oldBase := target.Scheme + "://" + target.Host
		newBase := "/hls"

		data = bytes.ReplaceAll(
			data,
			[]byte(oldBase+"/"),
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
		log.Printf("HLS proxy error: %v", err)

		http.Error(
			w,
			"HLS source unavailable",
			http.StatusBadGateway,
		)
	}

	// ----------------------------------------
	// Основной обработчик /hls/
	// ----------------------------------------
	http.Handle("/hls/", http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {

			if r.Method != http.MethodGet &&
				r.Method != http.MethodHead {

				http.Error(
					w,
					"Method not allowed",
					http.StatusMethodNotAllowed,
				)
				return
			}

			// --------------------------------
			// Проверка IP-адреса
			// --------------------------------
			clientIP := getHLSClientIP(r)

			if !isAllowedIP(clientIP) {
				writeHLSForbidden(w)
				return
			}

			// --------------------------------
			// Разрешённый IP: проксируем HLS
			// --------------------------------
			r.URL.Path = strings.TrimPrefix(
				r.URL.Path,
				"/hls",
			)

			r.URL.RawPath = ""

			r.Host = target.Host

			proxy.ServeHTTP(w, r)
		},
	))
}
