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
	"strconv"
	"strings"
	"time"
)

const hlsProxyBasePort = 9000

// Общий Transport для всех HLS-прокси.
// Не создаём новый пул TCP-соединений
// на каждый запрос .m3u8 или .ts.
var hlsProxyTransport = &http.Transport{
	Proxy: nil,
	DialContext: (&net.Dialer{
		Timeout:   5 * time.Second,
		KeepAlive: 30 * time.Second,
	}).DialContext,
	MaxIdleConns:          200,
	MaxIdleConnsPerHost:   10,
	IdleConnTimeout:       60 * time.Second,
	ResponseHeaderTimeout: 15 * time.Second,
	DisableCompression:    true,
}

// Возвращает IP клиента.
// X-Real-IP доверяем только от локального Nginx.
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

// Страница запрета доступа.
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

// Разрешаем только файлы, которые создаёт
// наш HLS worker.
//
// index.m3u8
// segment_000001.ts
func validHLSFilename(name string) bool {
	if name == "index.m3u8" {
		return true
	}

	if !strings.HasPrefix(name, "segment_") ||
		!strings.HasSuffix(name, ".ts") {
		return false
	}

	number := strings.TrimSuffix(
		strings.TrimPrefix(name, "segment_"),
		".ts",
	)

	if len(number) == 0 || len(number) > 20 {
		return false
	}

	for _, c := range number {
		if c < '0' || c > '9' {
			return false
		}
	}

	return true
}

// Обрабатываем ответ локального HLS HTTP-сервера.
func modifyHLSResponse(resp *http.Response) error {
	// CORS определяет TVAPLAY, а не upstream.
	resp.Header.Del("Access-Control-Allow-Origin")
	resp.Header.Del("Access-Control-Allow-Credentials")
	resp.Header.Del("Access-Control-Allow-Methods")
	resp.Header.Del("Access-Control-Allow-Headers")
	resp.Header.Del("Access-Control-Max-Age")

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
			strconv.Itoa(len(body)),
		)
		resp.Header.Set("Cache-Control", "no-store")

		return nil
	}

	if resp.StatusCode != http.StatusOK {
		return nil
	}

	// Manifest и сегменты не кешируем.
	resp.Header.Set("Cache-Control", "no-store")

	if strings.HasSuffix(
		resp.Request.URL.Path, ".m3u8",
	) {
		resp.Header.Set(
			"Content-Type",
			"application/vnd.apple.mpegurl",
		)
	} else if strings.HasSuffix(
		resp.Request.URL.Path, ".ts",
	) {
		resp.Header.Set(
			"Content-Type",
			"video/mp2t",
		)
	}

	// В данном случае переписывать M3U8 не нужно.
	// FFmpeg генерирует относительные имена:
	//
	// segment_000001.ts
	//
	// Браузер запрашивает их относительно:
	// /live/{id}/index.m3u8

	return nil
}

// Создаёт reverse proxy для конкретного
// локального порта FFmpeg.
func newLocalHLSProxy(
	channelID uint32,
	port int,
) *httputil.ReverseProxy {
	target := &url.URL{
		Scheme: "http",
		Host: net.JoinHostPort(
			"127.0.0.1",
			strconv.Itoa(port),
		),
	}

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = hlsProxyTransport
	proxy.ModifyResponse = modifyHLSResponse

	proxy.ErrorHandler = func(
		w http.ResponseWriter,
		r *http.Request,
		err error,
	) {
		log.Printf(
			"[HLS:%d] proxy error: %v",
			channelID, err,
		)

		http.Error(
			w,
			"HLS source unavailable",
			http.StatusBadGateway,
		)
	}

	return proxy
}

// Основной обработчик:
//
// /live/80/index.m3u8
// -> http://127.0.0.1:9080/index.m3u8
func serveHLS(w http.ResponseWriter, r *http.Request) {
	setHLSCORS(w, r)

	// CORS preflight.
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

	// Допустимые HTTP-методы.
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

	// Убираем /live/ и разбираем путь.
	//
	// 80/index.m3u8
	// 80/segment_000001.ts
	value := strings.TrimPrefix(
		r.URL.Path,
		"/live/",
	)

	parts := strings.Split(value, "/")

	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}

	// ID канала из URL.
	id64, err := strconv.ParseUint(
		parts[0], 10, 32,
	)

	if err != nil || id64 == 0 {
		http.NotFound(w, r)
		return
	}

	channelID := uint32(id64)
	filename := parts[1]

	// Защита от произвольных путей.
	if !validHLSFilename(filename) {
		http.NotFound(w, r)
		return
	}

	// Порт = 9000 + channels.id
	port64 := uint64(hlsProxyBasePort) + id64

	if port64 > 65535 {
		http.NotFound(w, r)
		return
	}

	port := int(port64)

	// Формируем запрос к локальному серверу.
	upstreamRequest := r.Clone(r.Context())

	upstreamRequest.URL.Path = "/" + filename
	upstreamRequest.URL.RawPath = ""
	upstreamRequest.URL.RawQuery = ""
	upstreamRequest.Host = net.JoinHostPort(
		"127.0.0.1",
		strconv.Itoa(port),
	)

	// Создаём лёгкий объект прокси.
	// TCP-пул используется общий.
	proxy := newLocalHLSProxy(channelID, port)

	proxy.ServeHTTP(w, upstreamRequest)
}

// Регистрация динамического HLS-маршрута.
func registerHLS() {
	http.HandleFunc("/live/", serveHLS)

	log.Printf(
		"[HLS] dynamic proxy registered: "+
			"/live/{id}/ -> 127.0.0.1:%d+id",
		hlsProxyBasePort,
	)
}
