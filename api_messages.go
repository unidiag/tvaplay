package main

import (
	"gorm.io/gorm"
	"main/models"
	"strconv"
	"strings"
	"time"
)

type clientMessageRow struct {
	ID          uint       `json:"id"`
	Title       string     `json:"title"`
	Body        string     `json:"body"`
	BodyFormat  string     `json:"body_format"`
	Priority    string     `json:"priority"`
	PublishedAt *time.Time `json:"published_at"`
	ExpiresAt   *time.Time `json:"expires_at"`
	DeliveredAt *time.Time `json:"delivered_at"`
	ReadAt      *time.Time `json:"read_at"`
}

func clientMessageError(ctx *ApiCtx, status, message string) map[string]any {
	ctx.Out["status"] = status
	ctx.Out["message"] = message
	return ctx.Out
}
func clientMessageDBError(ctx *ApiCtx, err error) map[string]any {
	slog("Client messages DB error: "+err.Error(), "error")
	return clientMessageError(ctx, "DB_ERROR", "Database operation failed")
}
func requireMessageUser(ctx *ApiCtx) bool {
	if ctx.User == nil || ctx.User.ID == 0 {
		clientMessageError(ctx, "AUTH_REQUIRED", "Authentication required")
		return false
	}
	return true
}
func clientMessagesQuery(tx *gorm.DB, userID uint, now time.Time) *gorm.DB {
	return tx.Table("message_recipients AS mr").Joins("JOIN messages AS m ON m.id = mr.message_id").Where("mr.user_id = ?", userID).Where("m.status = ?", models.MessageStatusPublished).Where("m.published_at <= ?", now).Where("(m.expires_at IS NULL OR m.expires_at > ?)", now)
}
func apiMessages(ctx *ApiCtx) map[string]any {
	if !requireMessageUser(ctx) {
		return ctx.Out
	}
	page, err := strconv.Atoi(ctx.D["page"])
	if err != nil || page < 1 {
		page = 1
	}
	limit, err := strconv.Atoi(ctx.D["limit"])
	if err != nil || limit < 1 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}
	if page > 100000 {
		return clientMessageError(ctx, "INVALID_PAGE", "Invalid page number")
	}
	now := time.Now()
	rows := make([]clientMessageRow, 0, limit+1)
	err = clientMessagesQuery(db.WithContext(ctx.R.Context()), ctx.User.ID, now).Select("m.id,m.title,m.body,m.body_format,m.priority,m.published_at,m.expires_at,mr.delivered_at,mr.read_at").Order("m.published_at DESC, m.id DESC").Offset((page - 1) * limit).Limit(limit + 1).Scan(&rows).Error
	if err != nil {
		return clientMessageDBError(ctx, err)
	}
	hasMore := len(rows) > limit
	if hasMore {
		rows = rows[:limit]
	}
	ctx.Out["messages"] = rows
	ctx.Out["page"] = page
	ctx.Out["limit"] = limit
	ctx.Out["has_more"] = hasMore
	return ctx.Out
}
func apiMessagesUnread(ctx *ApiCtx) map[string]any {
	if !requireMessageUser(ctx) {
		return ctx.Out
	}
	var count int64
	err := clientMessagesQuery(db.WithContext(ctx.R.Context()), ctx.User.ID, time.Now()).Where("mr.read_at IS NULL").Count(&count).Error
	if err != nil {
		return clientMessageDBError(ctx, err)
	}
	ctx.Out["unread"] = count
	return ctx.Out
}
func apiMessageDelivered(ctx *ApiCtx) map[string]any { return updateClientMessageState(ctx, false) }
func apiMessageRead(ctx *ApiCtx) map[string]any      { return updateClientMessageState(ctx, true) }
func updateClientMessageState(ctx *ApiCtx, markRead bool) map[string]any {
	if !requireMessageUser(ctx) {
		return ctx.Out
	}
	parsedID, err := strconv.ParseUint(strings.TrimSpace(ctx.D["id"]), 10, strconv.IntSize)
	if err != nil || parsedID == 0 {
		return clientMessageError(ctx, "INVALID_ID", "Invalid message ID")
	}
	messageID := uint(parsedID)
	userID := ctx.User.ID
	now := time.Now()
	var result *gorm.DB
	conn := db.WithContext(ctx.R.Context())
	if markRead {
		result = conn.Exec(`UPDATE message_recipients AS mr JOIN messages AS m ON m.id=mr.message_id SET mr.delivered_at=COALESCE(mr.delivered_at,?),mr.read_at=COALESCE(mr.read_at,?),mr.updated_at=? WHERE mr.message_id=? AND mr.user_id=? AND m.status=? AND m.published_at<=? AND (m.expires_at IS NULL OR m.expires_at>?) AND (mr.delivered_at IS NULL OR mr.read_at IS NULL)`, now, now, now, messageID, userID, models.MessageStatusPublished, now, now)
	} else {
		result = conn.Exec(`UPDATE message_recipients AS mr JOIN messages AS m ON m.id=mr.message_id SET mr.delivered_at=?,mr.updated_at=? WHERE mr.message_id=? AND mr.user_id=? AND m.status=? AND m.published_at<=? AND (m.expires_at IS NULL OR m.expires_at>?) AND mr.delivered_at IS NULL`, now, now, messageID, userID, models.MessageStatusPublished, now, now)
	}
	if result.Error != nil {
		return clientMessageDBError(ctx, result.Error)
	}
	var state struct {
		ID          uint
		DeliveredAt *time.Time
		ReadAt      *time.Time
	}
	query := clientMessagesQuery(conn, userID, now).Select("m.id,mr.delivered_at,mr.read_at").Where("m.id = ?", messageID).Limit(1).Scan(&state)
	if query.Error != nil {
		return clientMessageDBError(ctx, query.Error)
	}
	if query.RowsAffected == 0 {
		return clientMessageError(ctx, "NOT_FOUND", "Message not found")
	}
	ctx.Out["id"] = state.ID
	ctx.Out["delivered_at"] = state.DeliveredAt
	ctx.Out["read_at"] = state.ReadAt
	return ctx.Out
}
