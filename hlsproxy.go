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
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return ""
	}

	peer, err := netip.ParseAddr(host)
	if err != nil {
		return ""
	}

	peer = peer.Unmap()

	// Допускаем доверенный локальный прокси,
	// а также отдельный сервер Nginx.
	trusted := peer.IsLoopback()

	proxyIP := strings.TrimSpace(
		getSetting("archive_trusted_proxy_ip"),
	)

	if proxyIP != "" {
		configuredIP, err := netip.ParseAddr(proxyIP)
		if err == nil && peer == configuredIP.Unmap() {
			trusted = true
		}
	}

	if trusted {
		// Только доверенному прокси разрешено
		// передавать настоящий IP клиента.
		forwarded := strings.TrimSpace(
			r.Header.Get("X-Real-IP"),
		)

		ip, err := netip.ParseAddr(forwarded)
		if err != nil {
			// Не подменяем неизвестный адрес IP прокси.
			return ""
		}

		return ip.Unmap().String()
	}

	// Прямое подключение без доверенного прокси.
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

func getHLSAdvertChannelID() (uint32, error) {
	value := strings.TrimSpace(
		getSetting("promo_chid"),
	)

	id, err := strconv.ParseUint(value, 10, 32)
	basePort := getHLSBasePort()
	if err != nil || id == 0 ||
		id > uint64(65535-basePort) {
		return 0, fmt.Errorf(
			"invalid promo_chid: %q", value,
		)
	}

	return uint32(id), nil
}

// Дополняет ссылки на TS-сегменты параметрами
// авторизации и фактического источника.
//
// sourceID нужен, чтобы сегменты из рекламного
// манифеста продолжали запрашиваться у рекламы
// даже после пополнения баланса.
func rewriteHLSManifest(
	body []byte,
	token string,
	sourceID uint32,
) []byte {
	lines := strings.Split(string(body), "\n")

	params := url.Values{}
	params.Set("src", strconv.FormatUint(
		uint64(sourceID), 10,
	))

	if token != "" {
		params.Set("ht", token)
	}

	suffix := "?" + params.Encode()

	for i, line := range lines {
		name := strings.TrimSuffix(line, "\r")

		if !strings.HasSuffix(name, ".ts") ||
			!validHLSFilename(name) {
			continue
		}

		// Сохраняем CRLF, если он был.
		if strings.HasSuffix(line, "\r") {
			lines[i] = name + suffix + "\r"
		} else {
			lines[i] = name + suffix
		}
	}

	return []byte(strings.Join(lines, "\n"))
}

func serveHLS(w http.ResponseWriter, r *http.Request) {
	setHLSCORS(w, r)

	if r.Method == http.MethodOptions {
		origin := r.Header.Get("Origin")

		if origin != "http://127.0.0.1:3000" &&
			origin != "http://localhost:3000" {
			http.Error(w, "Forbidden",
				http.StatusForbidden)
			return
		}

		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method != http.MethodGet &&
		r.Method != http.MethodHead {
		w.Header().Set(
			"Allow", "GET, HEAD, OPTIONS",
		)
		http.Error(w, "Method not allowed",
			http.StatusMethodNotAllowed)
		return
	}

	value := strings.TrimPrefix(
		r.URL.Path, "/live/",
	)
	parts := strings.Split(value, "/")

	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}

	id64, err := strconv.ParseUint(
		parts[0], 10, 32,
	)
	if err != nil || id64 == 0 ||
		id64 > uint64(65535-getHLSBasePort()) {
		http.NotFound(w, r)
		return
	}

	requestedID := uint32(id64)
	filename := parts[1]

	if !validHLSFilename(filename) {
		http.NotFound(w, r)
		return
	}

	allowed, token, homeDenied := getHLSAccess(r)

	if homeDenied {
		// Машинный код причины отказа для TV UI.
		w.Header().Set(
			"X-TVAPLAY-Error",
			"HOME_IP_CONFLICT",
		)
		w.Header().Set("Cache-Control", "no-store")
		writeHLSForbidden(w)
		return
	}

	sourceID := requestedID

	// Нет доступа — принудительно используем
	// канал из promo_chid.
	//
	// Если доступ есть, src позволяет сохранить
	// рекламный источник для сегментов ранее
	// полученного рекламного манифеста.
	srcParam := r.URL.Query().Get("src")

	if !allowed || srcParam != "" {
		advertID, err := getHLSAdvertChannelID()
		if err != nil {
			log.Printf("[HLS] promo config: %v", err)
			http.Error(w, "HLS unavailable",
				http.StatusServiceUnavailable)
			return
		}

		if !allowed || srcParam ==
			strconv.FormatUint(
				uint64(advertID), 10,
			) {
			sourceID = advertID
		}
	}

	port, ok := hlsChannelPort(getHLSBasePort(), sourceID)
	if !ok {
		http.NotFound(w, r)
		return
	}

	// Создаём запрос к локальному FileServer.
	upstreamRequest := r.Clone(r.Context())

	upstreamRequest.URL.Path = "/" + filename
	upstreamRequest.URL.RawPath = ""
	upstreamRequest.URL.RawQuery = ""
	upstreamRequest.Host = net.JoinHostPort(
		"127.0.0.1",
		strconv.Itoa(port),
	)

	// Используем существующий reverse proxy
	// с общим пулом TCP-соединений.
	proxy := newLocalHLSProxy(sourceID, port)

	// Расширяем существующий ModifyResponse:
	// TS передаём без изменений.
	// M3U8 переписываем с GET-параметрами.
	proxy.ModifyResponse = func(
		resp *http.Response,
	) error {
		if err := modifyHLSResponse(resp); err != nil {
			return err
		}

		if filename != "index.m3u8" ||
			r.Method == http.MethodHead ||
			resp.StatusCode != http.StatusOK {
			return nil
		}

		// Не позволяем загрузить бесконечно
		// большой ответ от upstream.
		const maxManifestSize = 1024 * 1024

		data, err := io.ReadAll(
			io.LimitReader(
				resp.Body,
				maxManifestSize+1,
			),
		)
		resp.Body.Close()

		if err != nil {
			return err
		}

		if len(data) > maxManifestSize {
			return fmt.Errorf(
				"HLS manifest too large",
			)
		}

		data = rewriteHLSManifest(
			data, token, sourceID,
		)

		resp.Body = io.NopCloser(
			bytes.NewReader(data),
		)
		resp.ContentLength = int64(len(data))
		resp.Header.Set(
			"Content-Length",
			strconv.Itoa(len(data)),
		)
		resp.Header.Set(
			"Content-Type",
			"application/vnd.apple.mpegurl",
		)
		resp.Header.Set("Cache-Control", "no-store")

		// Тело манифеста изменено.
		resp.Header.Del("ETag")
		resp.Header.Del("Last-Modified")
		resp.Header.Del("Accept-Ranges")

		return nil
	}

	// Count only completed, successful GET requests for actual media bytes.
	// The sourceID, not the requested ID, represents the delivered channel.
	if r.Method == http.MethodGet && allowed && strings.HasSuffix(filename, ".ts") {
		userID, authSessionID := viewStatsIdentity(token)
		if userID != 0 {
			tracked := &viewStatsResponseWriter{ResponseWriter: w}
			proxy.ServeHTTP(tracked, upstreamRequest)
			if tracked.delivered() {
				viewStatsObserve(
					userID,
					sourceID,
					authSessionID,
					viewStatsCurrentProgrammeID(sourceID),
					"live",
					getHLSClientIP(r),
					filename,
				)
			}
			return
		}
	}
	proxy.ServeHTTP(w, upstreamRequest)
}

// Регистрация динамического HLS-маршрута.
func registerHLS() {
	http.HandleFunc("/live/", serveHLS)

	log.Printf(
		"[HLS] dynamic proxy registered: "+
			"/live/{id}/ -> 127.0.0.1:%d+id",
		getHLSBasePort(),
	)
}
