package main

import (
	"main/models"
	"strconv"
	"strings"
	"time"
)

func apiAccountDevices(ctx *ApiCtx) map[string]any {
	out := ctx.Out

	// Аккаунт берём только из авторизованного JWT.
	if ctx.User == nil {
		out["status"] = "UNAUTHORIZED"
		out["message"] = "Требуется авторизация"
		return out
	}

	now := time.Now()

	var sessions []models.UserRefreshToken

	err := db.
		Where(
			"user_id = ? AND expires_at > ?",
			ctx.User.ID, now,
		).
		Order("created_at DESC, id DESC").
		Find(&sessions).Error

	if err != nil {
		out["status"] = "DB_ERROR"
		out["message"] = "Ошибка получения устройств"
		return out
	}

	devices := make([]map[string]any, 0, len(sessions))
	seen := make(map[string]bool)

	currentUID := strings.TrimSpace(ctx.D["uid"])

	for _, session := range sessions {
		uid := strings.TrimSpace(session.UID)

		if uid == "" || seen[uid] {
			continue
		}

		seen[uid] = true

		country := "?"
		if session.IP != "" {
			country = geoIP(session.IP)
			if country == "" {
				country = "?"
			}
		}

		devices = append(devices, map[string]any{
			"id":         session.ID,
			"uid":        uid,
			"ip":         session.IP,
			"country":    country,
			"user_agent": session.UserAgent,
			"created_at": session.CreatedAt.UTC().
				Format(time.RFC3339),
			"current": uid == currentUID,
		})
	}

	out["status"] = "OK"
	out["devices"] = devices
	out["count"] = len(devices)
	out["max_dev"] = userDeviceLimit(ctx.User.MaxDev)

	return out
}

func apiAccountDeviceRevoke(ctx *ApiCtx) map[string]any {
	out := ctx.Out

	if ctx.User == nil {
		out["status"] = "UNAUTHORIZED"
		out["message"] = "Требуется авторизация"
		return out
	}

	// ID сессии, выбранной пользователем.
	id, err := strconv.ParseUint(
		strings.TrimSpace(ctx.D["id"]),
		10,
		64,
	)

	if err != nil || id == 0 {
		out["status"] = "INVALID_ID"
		out["message"] = "Некорректный ID сессии"
		return out
	}

	// Находим сессию только внутри своего аккаунта.
	var session models.UserRefreshToken

	err = db.Where(
		"id = ? AND user_id = ?",
		id,
		ctx.User.ID,
	).First(&session).Error

	if err != nil {
		out["status"] = "NOT_FOUND"
		out["message"] = "Сессия не найдена"
		return out
	}

	if session.UID == "" {
		out["status"] = "INVALID_UID"
		out["message"] = "Некорректный UID сессии"
		return out
	}

	// Определяем текущее устройство.
	currentUID := strings.TrimSpace(ctx.D["uid"])

	// Удаляем все refresh-сессии этого устройства.
	result := db.Where(
		"user_id = ? AND uid = ?",
		ctx.User.ID,
		session.UID,
	).Delete(&models.UserRefreshToken{})

	if result.Error != nil {
		out["status"] = "DB_ERROR"
		out["message"] = "Не удалось удалить сессию"
		return out
	}

	out["status"] = "OK"
	out["message"] = "Сессия удалена"
	out["current"] = session.UID == currentUID

	return out
}
