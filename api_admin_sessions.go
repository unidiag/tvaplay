package main

import (
	"main/models"
	"time"
)

// POST {"op":"adminSessions"}
// Список всех refresh-сессий всех пользователей.
func apiAdminSessions(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	type sessionRow struct {
		ID        uint      `json:"id"`
		UserID    uint      `json:"user_id"`
		Login     string    `json:"login"`
		UID       string    `json:"uid"`
		IP        string    `json:"ip"`
		UserAgent string    `json:"user_agent"`
		UpdatedAt time.Time `json:"updated_at"`
		CreatedAt time.Time `json:"created_at"`
		ExpiresAt time.Time `json:"expires_at"`
	}

	var rows []sessionRow

	err := db.WithContext(ctx.R.Context()).
		Table("user_refresh_tokens AS s").
		Select(`
            s.id,
            s.user_id,
            COALESCE(u.login, '') AS login,
            s.uid,
            s.ip,
			s.updated_at,
            s.user_agent,
            s.created_at,
            s.expires_at
        `).
		Joins("LEFT JOIN users AS u ON u.id = s.user_id").
		Order("s.id DESC").
		Scan(&rows).Error

	if err != nil {
		return adminUserError(
			ctx,
			"NOK",
			"Cannot load sessions",
		)
	}

	now := time.Now()

	sessions := make([]map[string]any, 0, len(rows))
	activeCount := 0

	for _, row := range rows {
		active := row.ExpiresAt.After(now)

		if active {
			activeCount++
		}

		sessions = append(sessions, map[string]any{
			"id":         row.ID,
			"user_id":    row.UserID,
			"login":      row.Login,
			"uid":        row.UID,
			"ip":         row.IP,
			"user_agent": row.UserAgent,
			"updated_at": row.UpdatedAt,
			"created_at": row.CreatedAt,
			"expires_at": row.ExpiresAt,
			"active":     active,
			"country":    geoIP(row.IP),
		})
	}

	ctx.Out["sessions"] = sessions
	ctx.Out["total"] = len(sessions)
	ctx.Out["active"] = activeCount
	ctx.Out["expired"] = len(sessions) - activeCount

	// Исключаем кэширование административных данных.
	ctx.W.Header().Set("Cache-Control", "no-store")

	return ctx.Out
}

// Проверка типа модели при компиляции.
// Используем ту же таблицу, что и UserSessions.
var _ = models.UserRefreshToken{}

// POST {"op":"adminSessionDelete", "id":123}
//
// Удаление refresh-сессии по ID.
// Доступно только администраторам.
func apiAdminSessionDelete(ctx *ApiCtx) map[string]any {

	// Проверка прав администратора
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}

	// Проверка ID сессии
	sessionID, err := parseAdminUserID(ctx.D["id"])
	if err != nil {
		return adminUserError(
			ctx,
			"INVALID_SESSION",
			"Invalid session ID",
		)
	}

	// Удаляем исключительно указанную сессию
	result := db.WithContext(ctx.R.Context()).
		Where("id = ?", sessionID).
		Delete(&models.UserRefreshToken{})

	// Ошибка базы данных
	if result.Error != nil {
		return adminUserError(
			ctx,
			"NOK",
			"Cannot delete session",
		)
	}

	// Сессия не найдена
	if result.RowsAffected == 0 {
		return adminUserError(
			ctx,
			"SESSION_NOT_FOUND",
			"Session not found",
		)
	}

	// Запрещаем кэширование ответа
	ctx.W.Header().Set("Cache-Control", "no-store")

	// Успешное удаление
	ctx.Out["deleted_session_id"] = sessionID

	return ctx.Out
}
