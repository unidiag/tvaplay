package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"main/models"

	"gorm.io/gorm"
)

// Текущая передача в формате, который
// ожидает TV UI (20-epg.js).
type epgNowProgramme struct {
	ID          uint64 `json:"id"`
	ChannelID   string `json:"channel_id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	Start       int64  `json:"start"`
	Stop        int64  `json:"stop"`
	Rating      string `json:"rating"`
	Icon        string `json:"icon"`
}

// getEPGNow возвращает текущую программу
// передач для всех включённых телеканалов.
func apiEPGNow(ctx *ApiCtx) map[string]any {
	out := ctx.Out

	now := time.Now()

	// Даже при отсутствии EPG возвращаем
	// корректную структуру для TV UI.
	programmes := make(map[string]epgNowProgramme)

	out["server_time"] = now.UnixMilli()
	out["programmes"] = programmes

	// ------------------------------------
	// 1. Получаем EPG ID включённых каналов
	// ------------------------------------
	var epgIDs []string

	err := db.WithContext(ctx.R.Context()).
		Model(&models.Channel{}).
		Where("enable = ?", 1).
		Where("epgid IS NOT NULL AND epgid <> ''").
		Distinct().
		Pluck("epgid", &epgIDs).Error

	if err != nil {
		return epgAPIError(out, err)
	}

	// Нормализуем пробелы и исключаем дубликаты.
	enabled := make(map[string]bool)
	ids := make([]string, 0, len(epgIDs))

	for _, id := range epgIDs {
		id = strings.TrimSpace(id)

		if id == "" || enabled[id] {
			continue
		}

		enabled[id] = true
		ids = append(ids, id)
	}

	if len(ids) == 0 {
		slog("EPG API: no enabled channels with EPG ID")
		return out
	}

	// ------------------------------------
	// 2. Получаем текущие передачи
	//
	// ВАЖНО:
	// epg_programmes.channel_id = channels.epgid
	// ------------------------------------
	var rows []models.EPGProgramme

	err = db.WithContext(ctx.R.Context()).
		Model(&models.EPGProgramme{}).
		Where("channel_id IN ?", ids).
		Where("start <= ? AND stop > ?", now, now).
		Order("channel_id ASC").
		Order("start DESC").
		Find(&rows).Error

	if err != nil {
		return epgAPIError(out, err)
	}

	// ------------------------------------
	// 3. Формируем ответ для TV UI
	// ------------------------------------
	for _, p := range rows {
		channelID := strings.TrimSpace(p.ChannelID)

		if channelID == "" || !enabled[channelID] {
			continue
		}

		// При пересечении передач выбираем
		// передачу с наиболее поздним start.
		if _, exists := programmes[channelID]; exists {
			continue
		}

		programmes[channelID] = epgNowProgramme{
			ID:          p.ID,
			ChannelID:   channelID,
			Title:       p.Title,
			Description: p.Description,
			Start:       p.Start.UnixMilli(),
			Stop:        p.Stop.UnixMilli(),
			Rating:      p.Rating,
			Icon:        p.Icon,
		}
	}

	return out
}

// Единая обработка ошибок базы данных.
func epgAPIError(
	out map[string]any,
	err error,
) map[string]any {
	slog(
		"EPG API database error: "+err.Error(),
		"error",
	)

	out["status"] = "DATABASE_ERROR"
	out["message"] = "Failed to load programme guide"

	return out
}

func serveEPGArchive(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")

	respond := func(statusCode int, status, message string) {
		w.WriteHeader(statusCode)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":  status,
			"message": message,
		})
	}

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		respond(http.StatusMethodNotAllowed,
			"METHOD_NOT_ALLOWED", "GET method required")
		return
	}

	user, err := getAuthUser(r)
	if err != nil || user == nil {
		respond(http.StatusUnauthorized,
			"UNAUTHORIZED", "Authorization required")
		return
	}

	// channel_id — это tvg-id из playlist.m3u,
	// то есть channels.epgid, а не числовой ID канала.
	epgID := strings.TrimSpace(
		r.URL.Query().Get("channel_id"),
	)

	if epgID == "" || len(epgID) > 64 {
		respond(http.StatusBadRequest,
			"INVALID_CHANNEL", "Invalid EPG ID")
		return
	}

	fromMS, errFrom := strconv.ParseInt(
		r.URL.Query().Get("from"), 10, 64,
	)
	toMS, errTo := strconv.ParseInt(
		r.URL.Query().Get("to"), 10, 64,
	)

	if errFrom != nil || errTo != nil ||
		fromMS <= 0 || toMS <= fromMS {
		respond(http.StatusBadRequest,
			"INVALID_PERIOD", "Invalid time period")
		return
	}

	// Находим разрешённый канал и его срок записи.
	var channel models.Channel

	err = db.WithContext(r.Context()).
		Where("enable = ? AND epgid = ? AND record > ?",
			1, epgID, 0).
		Order("id ASC").
		First(&channel).Error

	if err != nil {
		// Не раскрываем наличие выключенных/чужих каналов.
		if err == gorm.ErrRecordNotFound {
			respond(http.StatusNotFound,
				"CHANNEL_NOT_FOUND",
				"Channel with archive not found")
			return
		}

		slog("EPG archive channel query: "+err.Error(), "error")
		respond(http.StatusInternalServerError,
			"DATABASE_ERROR", "Database error")
		return
	}

	now := time.Now()
	nowMS := now.UnixMilli()

	// Клиент не может запросить данные старше срока записи.
	earliestMS := now.Add(
		-time.Duration(channel.Record) * time.Hour,
	).UnixMilli()

	if fromMS < earliestMS {
		fromMS = earliestMS
	}
	if toMS > nowMS {
		toMS = nowMS
	}

	programmes := make([]epgNowProgramme, 0)

	// За пределами архива возвращаем пустой список.
	if fromMS >= toMS {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"status":     "OK",
			"channel_id": epgID,
			"from":       fromMS,
			"to":         toMS,
			"programmes": programmes,
		})
		return
	}

	from := time.UnixMilli(fromMS)
	to := time.UnixMilli(toMS)

	var rows []models.EPGProgramme

	err = db.WithContext(r.Context()).
		Where("channel_id = ?", epgID).
		Where("stop > ? AND start < ?", from, to).
		Where("stop <= ?", now).
		Order("start DESC").
		Limit(2000).
		Find(&rows).Error

	if err != nil {
		slog("EPG archive programmes query: "+err.Error(), "error")
		respond(http.StatusInternalServerError,
			"DATABASE_ERROR", "Failed to load EPG")
		return
	}

	for _, p := range rows {
		programmes = append(programmes, epgNowProgramme{
			ID:          p.ID,
			ChannelID:   p.ChannelID,
			Title:       p.Title,
			Description: p.Description,
			Start:       p.Start.UnixMilli(),
			Stop:        p.Stop.UnixMilli(),
			Rating:      p.Rating,
			Icon:        p.Icon,
		})
	}

	_ = json.NewEncoder(w).Encode(map[string]any{
		"status":     "OK",
		"channel_id": epgID,
		"from":       fromMS,
		"to":         toMS,
		"programmes": programmes,
	})
}
