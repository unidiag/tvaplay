package main

import (
	"crypto/rand"
	"io"
	"log"
	"net/http"
	"strconv"
)

const (
	speedTestSize  = 32 * 1024 * 1024 // 32 MiB
	speedChunkSize = 64 * 1024        // 64 KiB
)

// Не более двух параллельных тестов на процесс.
var speedTestSlots = make(chan struct{}, 2)

func serveSpeedTest(w http.ResponseWriter, r *http.Request) {
	setDevCORS(w, r)

	if r.Method == http.MethodOptions {
		if !debug {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}

		w.WriteHeader(http.StatusNoContent)
		return
	}

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET, OPTIONS")
		http.Error(
			w,
			"Method not allowed",
			http.StatusMethodNotAllowed,
		)
		return
	}

	// Только авторизованные пользователи.
	user, err := getAuthUser(r)
	if err != nil || user == nil {
		http.Error(
			w,
			"Unauthorized",
			http.StatusUnauthorized,
		)
		return
	}

	// Не позволяем тестам перегрузить сервер.
	select {
	case speedTestSlots <- struct{}{}:
		defer func() {
			<-speedTestSlots
		}()
	default:
		http.Error(
			w,
			"Too many speed tests",
			http.StatusTooManyRequests,
		)
		return
	}

	// Генерируем несжимаемые данные один раз на запрос.
	chunk := make([]byte, speedChunkSize)

	if _, err := rand.Read(chunk); err != nil {
		log.Printf("[speedtest] random data error: %v", err)

		http.Error(
			w,
			"Speed test initialization error",
			http.StatusInternalServerError,
		)
		return
	}

	w.Header().Set(
		"Content-Type",
		"application/octet-stream",
	)
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.Header().Set("Content-Encoding", "identity")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set(
		"Content-Length",
		strconv.Itoa(speedTestSize),
	)

	remaining := speedTestSize

	for remaining > 0 {
		// Клиент отменил тест или закрыл страницу.
		if r.Context().Err() != nil {
			return
		}

		size := len(chunk)
		if remaining < size {
			size = remaining
		}

		n, err := w.Write(chunk[:size])
		remaining -= n

		if err != nil {
			if err != io.EOF {
				log.Printf("[speedtest] write error: %v", err)
			}
			return
		}

		if n == 0 {
			return
		}
	}
}
