package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"main/models"
)

const (
	hlsBasePort   = 9000
	hlsDirectory  = "/tmp/tvaplay-hls"
	hlsCheckTime  = 3 * time.Second
	hlsRetryTime  = 5 * time.Second
	hlsFFmpegPath = "/usr/bin/ffmpeg"
)

type hlsWorker struct {
	channel models.Channel
	cancel  context.CancelFunc
	done    chan struct{}
}

// Менеджер всех включённых каналов.
func hlsManager(ctx context.Context) {
	workers := make(map[uint32]*hlsWorker)

	ticker := time.NewTicker(hlsCheckTime)
	defer ticker.Stop()

	defer func() {
		for _, worker := range workers {
			worker.cancel()
		}
		for _, worker := range workers {
			<-worker.done
		}
	}()

	reconcileHLS(ctx, workers)

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			reconcileHLS(ctx, workers)
		}
	}
}

// Сверяем текущие процессы с таблицей channels.
func reconcileHLS(
	ctx context.Context,
	workers map[uint32]*hlsWorker,
) {
	var channels []models.Channel

	err := db.WithContext(ctx).
		Select("id", "name", "udp", "enable").
		Where("enable = ?", 1).
		Find(&channels).Error

	if err != nil {
		if ctx.Err() == nil {
			log.Printf("[HLS] database error: %v", err)
		}
		return
	}

	enabled := make(map[uint32]models.Channel)

	for _, channel := range channels {
		source, err := normalizeUDP(channel.UDP)

		if err != nil {
			log.Printf(
				"[HLS] skip id=%d: %v",
				channel.ID, err,
			)
			continue
		}

		// Сохраняем нормализованный адрес в рабочей копии.
		// Значение channels.udp в базе не меняется.
		channel.UDP = source

		port := uint64(hlsBasePort) + uint64(channel.ID)
		if port > 65535 || port <= 1024 {
			log.Printf(
				"[HLS] invalid port for id=%d",
				channel.ID,
			)
			continue
		}

		enabled[channel.ID] = channel
	}

	// Останавливаем выключенные, удалённые,
	// изменённые и завершившиеся процессы.
	for id, worker := range workers {
		channel, exists := enabled[id]

		finished := false
		select {
		case <-worker.done:
			finished = true
		default:
		}

		if exists &&
			!finished &&
			channel.UDP == worker.channel.UDP {
			continue
		}

		worker.cancel()
		<-worker.done
		delete(workers, id)

		log.Printf("[HLS] stopped channel=%d", id)
	}

	// Запускаем новые каналы.
	for id, channel := range enabled {
		if _, exists := workers[id]; exists {
			continue
		}

		workerCtx, cancel := context.WithCancel(ctx)

		worker := &hlsWorker{
			channel: channel,
			cancel:  cancel,
			done:    make(chan struct{}),
		}

		workers[id] = worker

		go func() {
			defer close(worker.done)
			runHLSWorker(workerCtx, worker.channel)
		}()

		log.Printf(
			"[HLS] starting id=%d name=%q port=%d",
			id, channel.Name, hlsBasePort+int(id),
		)
	}
}

func runHLSWorker(
	ctx context.Context,
	channel models.Channel,
) {
	port := hlsBasePort + int(channel.ID)
	directory := filepath.Join(
		hlsDirectory,
		strconv.FormatUint(uint64(channel.ID), 10),
	)

	if err := os.MkdirAll(directory, 0750); err != nil {
		log.Printf("[HLS:%d] mkdir: %v", channel.ID, err)
		return
	}
	defer os.RemoveAll(directory)

	// HTTP-сервер только для локального Go-прокси.
	listener, err := net.Listen(
		"tcp",
		fmt.Sprintf("127.0.0.1:%d", port),
	)
	if err != nil {
		log.Printf(
			"[HLS:%d] listen port %d: %v",
			channel.ID, port, err,
		)
		return
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir(directory)))

	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	serverDone := make(chan struct{})

	go func() {
		defer close(serverDone)

		if err := server.Serve(listener); err != nil &&
			err != http.ErrServerClosed {
			log.Printf(
				"[HLS:%d] HTTP error: %v",
				channel.ID, err,
			)
		}
	}()

	defer func() {
		shutdownCtx, cancel := context.WithTimeout(
			context.Background(), 3*time.Second,
		)
		defer cancel()

		_ = server.Shutdown(shutdownCtx)
		_ = server.Close()
		<-serverDone
	}()

	// ffmpeg может падать из-за потери UDP.
	// Повторяем запуск, пока канал включён.
	for ctx.Err() == nil {
		// Очищаем старый HLS перед новым запуском.
		if err := os.RemoveAll(directory); err != nil {
			log.Printf(
				"[HLS:%d] cleanup error: %v",
				channel.ID, err,
			)
		}

		if err := os.MkdirAll(directory, 0750); err != nil {
			log.Printf(
				"[HLS:%d] mkdir error: %v",
				channel.ID, err,
			)
			return
		}

		err := runFFmpeg(ctx, channel, directory)

		if ctx.Err() != nil {
			return
		}

		log.Printf(
			"[HLS:%d] ffmpeg stopped: %v; retry in %s",
			channel.ID, err, hlsRetryTime,
		)

		select {
		case <-ctx.Done():
			return
		case <-time.After(hlsRetryTime):
		}
	}
}

func runFFmpeg(
	ctx context.Context,
	channel models.Channel,
	directory string,
) error {
	playlist := filepath.Join(directory, "index.m3u8")
	segments := filepath.Join(directory, "segment_%06d.ts")

	args := []string{
		"-hide_banner",
		"-nostdin",
		"-loglevel", "error",

		"-fflags", "+genpts+discardcorrupt",
		"-thread_queue_size", "1024",
		"-i", channel.UDP,

		"-map", "0:v:0?",
		"-map", "0:a:0?",

		"-c:v", "copy",
		"-c:a", "aac",
		"-b:a", "128k",
		"-ac", "2",

		"-f", "hls",
		"-hls_time", "4",
		"-hls_list_size", "6",
		"-hls_delete_threshold", "3",
		"-hls_flags", "delete_segments+omit_endlist",
		"-hls_segment_filename", segments,

		playlist,
	}

	cmd := exec.CommandContext(
		ctx, hlsFFmpegPath, args...,
	)
	cmd.Stdout = nil
	cmd.Stderr = os.Stderr

	log.Printf(
		"[HLS:%d] ffmpeg input=%s",
		channel.ID, channel.UDP,
	)

	return cmd.Run()
}

// Публичный маршрут через основной Go-сервер.
// /live/12/index.m3u8 -> 127.0.0.1:9012/index.m3u8
func serveLocalHLS(
	w http.ResponseWriter,
	r *http.Request,
) {
	setHLSCORS(w, r)

	if r.Method == http.MethodOptions {
		origin := r.Header.Get("Origin")
		if origin != "http://127.0.0.1:3000" &&
			origin != "http://localhost:3000" {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method != http.MethodGet &&
		r.Method != http.MethodHead {
		http.Error(
			w, "Method not allowed",
			http.StatusMethodNotAllowed,
		)
		return
	}

	parts := strings.Split(
		strings.TrimPrefix(r.URL.Path, "/live/"), "/",
	)

	if len(parts) != 2 {
		http.NotFound(w, r)
		return
	}

	id64, err := strconv.ParseUint(parts[0], 10, 32)
	if err != nil || id64 == 0 {
		http.NotFound(w, r)
		return
	}

	port := uint64(hlsBasePort) + id64
	if port > 65535 {
		http.NotFound(w, r)
		return
	}

	filename := parts[1]

	// Разрешаем только manifest и TS-сегменты.
	valid := filename == "index.m3u8"

	if strings.HasPrefix(filename, "segment_") &&
		strings.HasSuffix(filename, ".ts") {
		number := strings.TrimSuffix(
			strings.TrimPrefix(filename, "segment_"),
			".ts",
		)
		if len(number) > 0 && len(number) <= 20 {
			valid = true
			for _, c := range number {
				if c < '0' || c > '9' {
					valid = false
					break
				}
			}
		}
	}

	if !valid {
		http.NotFound(w, r)
		return
	}

	target, _ := url.Parse(fmt.Sprintf(
		"http://127.0.0.1:%d", port,
	))

	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout: 3 * time.Second,
		}).DialContext,
		ResponseHeaderTimeout: 5 * time.Second,
	}

	proxy.ErrorHandler = func(
		w http.ResponseWriter,
		r *http.Request,
		err error,
	) {
		http.Error(
			w, "HLS channel unavailable",
			http.StatusServiceUnavailable,
		)
	}

	r2 := r.Clone(r.Context())
	r2.URL.Path = "/" + filename
	r2.URL.RawPath = ""
	r2.URL.RawQuery = ""
	r2.Host = target.Host

	w.Header().Set("Cache-Control", "no-store")

	if filename == "index.m3u8" {
		w.Header().Set(
			"Content-Type",
			"application/vnd.apple.mpegurl",
		)
	} else {
		w.Header().Set("Content-Type", "video/mp2t")
	}

	proxy.ServeHTTP(w, r2)
}

const defaultUDPPort = 1234

func normalizeUDP(value string) (string, error) {
	value = strings.TrimSpace(value)

	if value == "" {
		return "", fmt.Errorf("empty UDP address")
	}

	// Принимаем как IP:port, так и полный udp:// URL.
	value = strings.TrimPrefix(value, "udp://")
	value = strings.TrimPrefix(value, "UDP://")

	// Удаляем @ перед multicast IP, если он уже указан.
	value = strings.TrimPrefix(value, "@")

	// Поддерживаем параметры FFmpeg, например:
	// udp://@237.0.100.4:1234?localaddr=192.168.1.10
	address := value
	rawQuery := ""

	if i := strings.IndexByte(value, '?'); i >= 0 {
		address = value[:i]
		rawQuery = value[i+1:]
	}

	if address == "" {
		return "", fmt.Errorf("missing UDP host")
	}

	// Если порт отсутствует, используем 1234.
	host := address
	port := defaultUDPPort

	if strings.Contains(address, ":") {
		var portStr string
		var err error

		host, portStr, err = net.SplitHostPort(address)
		if err != nil {
			return "", fmt.Errorf(
				"invalid UDP address %q: %w", value, err,
			)
		}

		p, err := strconv.Atoi(portStr)
		if err != nil || p < 1 || p > 65535 {
			return "", fmt.Errorf(
				"invalid UDP port %q", portStr,
			)
		}

		port = p
	}

	// Проверяем, что адрес является IPv4 multicast.
	ip := net.ParseIP(host)

	if ip == nil || ip.To4() == nil || !ip.IsMulticast() {
		return "", fmt.Errorf(
			"invalid multicast IPv4 address %q", host,
		)
	}

	normalized := fmt.Sprintf(
		"udp://@%s:%d",
		ip.String(),
		port,
	)

	// Сохраняем дополнительные параметры FFmpeg.
	if rawQuery != "" {
		if _, err := url.ParseQuery(rawQuery); err != nil {
			return "", fmt.Errorf(
				"invalid UDP parameters: %w", err,
			)
		}

		normalized += "?" + rawQuery
	}

	return normalized, nil
}
