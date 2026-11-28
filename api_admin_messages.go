package main

import (
	"encoding/json"
	"errors"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"main/models"
	"strings"
	"time"
	"unicode/utf8"
)

type adminMessageSaveRequest struct {
	ID         uint       `json:"id"`
	Title      string     `json:"title"`
	Body       string     `json:"body"`
	BodyFormat string     `json:"body_format"`
	Audience   string     `json:"audience"`
	Priority   string     `json:"priority"`
	SendSMS    bool       `json:"send_sms"`
	SMSText    string     `json:"sms_text"`
	UserIDs    []uint     `json:"user_ids"`
	ExpiresAt  *time.Time `json:"expires_at"`
}
type adminMessageRow struct {
	models.Message
	Recipients int64 `json:"recipients"`
	Delivered  int64 `json:"delivered"`
	Read       int64 `json:"read"`
	SMSPending int64 `json:"sms_pending"`
	SMSSent    int64 `json:"sms_sent"`
	SMSFailed  int64 `json:"sms_failed"`
	SMSUnknown int64 `json:"sms_unknown"`
}
type adminMessageUserRow struct {
	ID        uint   `json:"id"`
	Login     string `json:"login"`
	BillingID uint64 `json:"billing_id"`
	Info      string `json:"info"`
	Status    uint   `json:"status"`
}

var (
	errMessageNotFound = errors.New("Message not found")
	errMessageNotDraft = errors.New("Message is not a draft")
	errMessageNoUsers  = errors.New("No recipients selected")
	errMessageUsers    = errors.New("Invalid recipients")
	errMessageExpired  = errors.New("Message has expired")
	errMessageState    = errors.New("Invalid message status")
)

func adminMessageError(ctx *ApiCtx, status, message string) map[string]any {
	ctx.Out["status"] = status
	ctx.Out["message"] = message
	return ctx.Out
}
func adminMessageDBError(ctx *ApiCtx, err error) map[string]any {
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound), errors.Is(err, errMessageNotFound):
		return adminMessageError(ctx, "NOT_FOUND", "Message not found")
	case errors.Is(err, errMessageNotDraft), errors.Is(err, errMessageState):
		return adminMessageError(ctx, "INVALID_STATUS", err.Error())
	case errors.Is(err, errMessageNoUsers), errors.Is(err, errMessageUsers):
		return adminMessageError(ctx, "INVALID_RECIPIENTS", err.Error())
	case errors.Is(err, errMessageExpired):
		return adminMessageError(ctx, "EXPIRED", err.Error())
	}
	slog("Messages DB error: "+err.Error(), "error")
	return adminMessageError(ctx, "NOK", "Database operation failed")
}
func lockAdminMessage(tx *gorm.DB, id uint) (models.Message, error) {
	var message models.Message
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&message, id).Error
	return message, err
}
func apiAdminMessages(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	type messageStats struct {
		MessageID                                                                    uint
		Recipients, Delivered, ReadCount, SMSPending, SMSSent, SMSFailed, SMSUnknown int64
	}
	messages := make([]models.Message, 0)
	if err := db.Order("id DESC").Find(&messages).Error; err != nil {
		return adminMessageDBError(ctx, err)
	}
	stats := make([]messageStats, 0)
	err := db.Model(&models.MessageRecipient{}).Select(`message_id, COUNT(*) AS recipients,
 SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
 SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read_count,
 SUM(CASE WHEN sms_status IN ('pending','processing') THEN 1 ELSE 0 END) AS sms_pending,
 SUM(CASE WHEN sms_status = 'sent' THEN 1 ELSE 0 END) AS sms_sent,
 SUM(CASE WHEN sms_status = 'failed' THEN 1 ELSE 0 END) AS sms_failed,
 SUM(CASE WHEN sms_status = 'unknown' THEN 1 ELSE 0 END) AS sms_unknown`).Group("message_id").Scan(&stats).Error
	if err != nil {
		return adminMessageDBError(ctx, err)
	}
	statsByID := make(map[uint]messageStats, len(stats))
	for _, item := range stats {
		statsByID[item.MessageID] = item
	}
	rows := make([]adminMessageRow, 0, len(messages))
	for _, message := range messages {
		stat := statsByID[message.ID]
		rows = append(rows, adminMessageRow{Message: message, Recipients: stat.Recipients, Delivered: stat.Delivered, Read: stat.ReadCount, SMSPending: stat.SMSPending, SMSSent: stat.SMSSent, SMSFailed: stat.SMSFailed, SMSUnknown: stat.SMSUnknown})
	}
	ctx.Out["messages"] = rows
	return ctx.Out
}
func apiAdminMessageUsers(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	search := strings.TrimSpace(ctx.D["search"])
	users := make([]adminMessageUserRow, 0)
	if utf8.RuneCountInString(search) > 100 {
		return adminMessageError(ctx, "INVALID_SEARCH", "Search is too long")
	}
	if utf8.RuneCountInString(search) < 2 {
		ctx.Out["users"] = users
		return ctx.Out
	}
	search = strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(search)
	pattern := "%" + search + "%"
	err := db.Model(&models.User{}).Select("id, login, billing_id, info, status").Where(`(login LIKE ? ESCAPE '!' OR CAST(billing_id AS CHAR) LIKE ? ESCAPE '!' OR info LIKE ? ESCAPE '!')`, pattern, pattern, pattern).Order("login ASC").Limit(50).Scan(&users).Error
	if err != nil {
		return adminMessageDBError(ctx, err)
	}
	ctx.Out["users"] = users
	return ctx.Out
}
func apiAdminMessageGet(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	id, err := parseAdminUserID(ctx.D["id"])
	if err != nil {
		return adminMessageError(ctx, "INVALID_ID", "Invalid message ID")
	}
	var message models.Message
	if err := db.First(&message, id).Error; err != nil {
		return adminMessageDBError(ctx, err)
	}
	users := make([]adminMessageUserRow, 0)
	if message.Audience == models.MessageAudienceIndividual {
		err = db.Table("message_recipients AS mr").Select("u.id, u.login, u.billing_id, u.info, u.status").Joins("JOIN users AS u ON u.id = mr.user_id").Where("mr.message_id = ?", id).Order("u.login ASC").Scan(&users).Error
		if err != nil {
			return adminMessageDBError(ctx, err)
		}
	}
	userIDs := make([]uint, 0, len(users))
	for _, user := range users {
		userIDs = append(userIDs, user.ID)
	}
	ctx.Out["message"] = message
	ctx.Out["users"] = users
	ctx.Out["user_ids"] = userIDs
	return ctx.Out
}
func apiAdminMessageSave(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	var req adminMessageSaveRequest
	raw, err := json.Marshal(ctx.Data)
	if err != nil {
		return adminMessageError(ctx, "INVALID_DATA", "Invalid request")
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return adminMessageError(ctx, "INVALID_DATA", "Invalid message data")
	}
	req.Title = strings.TrimSpace(req.Title)
	req.Body = strings.TrimSpace(req.Body)
	req.SMSText = strings.TrimSpace(req.SMSText)
	req.BodyFormat = strings.ToLower(strings.TrimSpace(req.BodyFormat))
	if req.BodyFormat == "" {
		req.BodyFormat = models.MessageBodyFormatText
	}
	if req.Title == "" || utf8.RuneCountInString(req.Title) > 255 {
		return adminMessageError(ctx, "INVALID_TITLE", "Title must contain 1–255 characters")
	}
	if utf8.RuneCountInString(req.Body) > 10000 {
		return adminMessageError(ctx, "INVALID_BODY", "Message must not exceed 10000 characters")
	}
	switch req.BodyFormat {
	case models.MessageBodyFormatText:
	case models.MessageBodyFormatHTML:
		req.Body = sanitizeMessageHTML(req.Body)
		if !messageHTMLHasContent(req.Body) {
			return adminMessageError(ctx, "INVALID_BODY", "Message must contain text or an image")
		}
	default:
		return adminMessageError(ctx, "INVALID_BODY_FORMAT", "Invalid message body format")
	}
	if req.Body == "" || utf8.RuneCountInString(req.Body) > 10000 {
		return adminMessageError(ctx, "INVALID_BODY", "Message must contain 1–10000 characters")
	}
	switch req.Audience {
	case models.MessageAudienceAll, models.MessageAudienceIndividual:
	default:
		return adminMessageError(ctx, "INVALID_AUDIENCE", "Invalid audience")
	}
	if req.Priority == "" {
		req.Priority = models.MessagePriorityNormal
	}
	switch req.Priority {
	case models.MessagePriorityNormal, models.MessagePriorityImportant, models.MessagePriorityCritical:
	default:
		return adminMessageError(ctx, "INVALID_PRIORITY", "Invalid priority")
	}
	if req.ExpiresAt != nil && !req.ExpiresAt.After(time.Now()) {
		return adminMessageError(ctx, "INVALID_EXPIRES_AT", "Expiration must be in the future")
	}
	if req.SendSMS {
		smsText := req.SMSText
		if smsText == "" {
			if req.BodyFormat == models.MessageBodyFormatHTML {
				smsText = messageHTMLPlainText(req.Body)
			} else {
				smsText = req.Body
			}
		}
		smsText = strings.TrimSpace(smsText)
		if smsText == "" || utf8.RuneCountInString(smsText) > 1000 {
			return adminMessageError(ctx, "INVALID_SMS_TEXT", "SMS text must contain 1–1000 characters")
		}
		req.SMSText = smsText
	} else {
		req.SMSText = ""
	}
	if len(req.UserIDs) > 10000 {
		return adminMessageError(ctx, "INVALID_RECIPIENTS", "Too many selected recipients")
	}
	ids := make([]uint, 0, len(req.UserIDs))
	seen := make(map[uint]struct{})
	for _, id := range req.UserIDs {
		if id == 0 {
			return adminMessageError(ctx, "INVALID_RECIPIENTS", "Invalid user ID")
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	if req.Audience == models.MessageAudienceAll {
		ids = nil
	}
	if req.Audience == models.MessageAudienceIndividual && len(ids) == 0 {
		return adminMessageError(ctx, "INVALID_RECIPIENTS", "Select at least one subscriber")
	}
	var message models.Message
	err = db.Transaction(func(tx *gorm.DB) error {
		if req.ID > 0 {
			var err error
			message, err = lockAdminMessage(tx, req.ID)
			if err != nil {
				return err
			}
			if message.Status != models.MessageStatusDraft {
				return errMessageNotDraft
			}
		} else {
			message.CreatedBy = ctx.User.ID
			message.Status = models.MessageStatusDraft
		}
		if len(ids) > 0 {
			var count int64
			err := tx.Model(&models.User{}).Where("id IN ?", ids).Count(&count).Error
			if err != nil {
				return err
			}
			if count != int64(len(ids)) {
				return errMessageUsers
			}
		}
		message.Title = req.Title
		message.Body = req.Body
		message.BodyFormat = req.BodyFormat
		message.Audience = req.Audience
		message.Priority = req.Priority
		message.SendSMS = req.SendSMS
		message.SMSText = req.SMSText
		message.ExpiresAt = req.ExpiresAt
		if message.ID == 0 {
			if err := tx.Create(&message).Error; err != nil {
				return err
			}
		} else {
			if err := tx.Save(&message).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("message_id = ?", message.ID).Delete(&models.MessageRecipient{}).Error; err != nil {
			return err
		}
		if message.Audience == models.MessageAudienceIndividual {
			recipients := make([]models.MessageRecipient, 0, len(ids))
			for _, userID := range ids {
				recipients = append(recipients, models.MessageRecipient{MessageID: message.ID, UserID: userID, SMSStatus: models.MessageSMSDisabled})
			}
			if err := tx.CreateInBatches(&recipients, 500).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return adminMessageDBError(ctx, err)
	}
	ctx.Out["id"] = message.ID
	ctx.Out["message"] = message
	return ctx.Out
}
func apiAdminMessageDelete(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	id, err := parseAdminUserID(ctx.D["id"])
	if err != nil {
		return adminMessageError(ctx, "INVALID_ID", "Invalid message ID")
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		message, err := lockAdminMessage(tx, id)
		if err != nil {
			return err
		}
		if message.Status != models.MessageStatusDraft {
			return errMessageNotDraft
		}
		if err := tx.Where("message_id = ?", id).Delete(&models.MessageRecipient{}).Error; err != nil {
			return err
		}
		return tx.Delete(&message).Error
	})
	if err != nil {
		return adminMessageDBError(ctx, err)
	}
	ctx.Out["id"] = id
	return ctx.Out
}
func apiAdminMessagePublish(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	id, err := parseAdminUserID(ctx.D["id"])
	if err != nil {
		return adminMessageError(ctx, "INVALID_ID", "Invalid message ID")
	}
	var recipientsCount int64
	err = db.Transaction(func(tx *gorm.DB) error {
		message, err := lockAdminMessage(tx, id)
		if err != nil {
			return err
		}
		if message.Status == models.MessageStatusPublished {
			return tx.Model(&models.MessageRecipient{}).Where("message_id = ?", id).Count(&recipientsCount).Error
		}
		if message.Status != models.MessageStatusDraft {
			return errMessageNotDraft
		}
		now := time.Now()
		if message.ExpiresAt != nil && !message.ExpiresAt.After(now) {
			return errMessageExpired
		}
		switch message.Audience {
		case models.MessageAudienceAll:
			err = tx.Exec(`INSERT INTO message_recipients (message_id,user_id,sms_status,sms_attempts,created_at,updated_at) SELECT ?,id,'disabled',0,?,? FROM users`, message.ID, now, now).Error
			if err != nil {
				return err
			}
		case models.MessageAudienceIndividual:
			err = tx.Exec(`DELETE mr FROM message_recipients AS mr LEFT JOIN users AS u ON u.id = mr.user_id WHERE mr.message_id = ? AND u.id IS NULL`, message.ID).Error
			if err != nil {
				return err
			}
		default:
			return errMessageState
		}
		err = tx.Model(&models.MessageRecipient{}).Where("message_id = ?", id).Count(&recipientsCount).Error
		if err != nil {
			return err
		}
		if recipientsCount == 0 {
			return errMessageNoUsers
		}
		if message.SendSMS {
			err = tx.Exec(`UPDATE message_recipients AS mr JOIN users AS u ON u.id = mr.user_id SET mr.sms_phone=u.login,mr.sms_status='pending',mr.sms_attempts=0,mr.sms_next_at=?,mr.sms_locked_at=NULL,mr.sms_sent_at=NULL,mr.sms_error='',mr.updated_at=? WHERE mr.message_id=?`, now, now, id).Error
			if err != nil {
				return err
			}
		}
		return tx.Model(&message).Updates(map[string]any{"status": models.MessageStatusPublished, "published_at": now, "updated_at": now}).Error
	})
	if err != nil {
		return adminMessageDBError(ctx, err)
	}
	ctx.Out["id"] = id
	ctx.Out["recipients"] = recipientsCount
	ctx.Out["message_status"] = models.MessageStatusPublished
	return ctx.Out
}
func apiAdminMessageCancel(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	id, err := parseAdminUserID(ctx.D["id"])
	if err != nil {
		return adminMessageError(ctx, "INVALID_ID", "Invalid message ID")
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		message, err := lockAdminMessage(tx, id)
		if err != nil {
			return err
		}
		if message.Status == models.MessageStatusCancelled {
			return nil
		}
		switch message.Status {
		case models.MessageStatusPublished, models.MessageStatusScheduled:
		default:
			return errMessageState
		}
		now := time.Now()
		err = tx.Model(&models.MessageRecipient{}).Where("message_id = ?", id).Where("sms_status = ?", models.MessageSMSPending).Updates(map[string]any{"sms_status": models.MessageSMSCancelled, "sms_next_at": nil, "updated_at": now}).Error
		if err != nil {
			return err
		}
		return tx.Model(&message).Updates(map[string]any{"status": models.MessageStatusCancelled, "updated_at": now}).Error
	})
	if err != nil {
		return adminMessageDBError(ctx, err)
	}
	ctx.Out["id"] = id
	ctx.Out["message_status"] = models.MessageStatusCancelled
	return ctx.Out
}

type adminMessageRecipientRow struct {
	models.MessageRecipient
	Login     string `json:"login"`
	BillingID uint64 `json:"billing_id"`
}

func apiAdminMessageRecipients(ctx *ApiCtx) map[string]any {
	if !requireChannelAdmin(ctx) {
		return ctx.Out
	}
	id, err := parseAdminUserID(ctx.D["id"])
	if err != nil {
		return adminMessageError(ctx, "INVALID_ID", "Invalid message ID")
	}
	var req struct {
		Page   int    `json:"page"`
		Limit  int    `json:"limit"`
		Filter string `json:"filter"`
	}
	raw, err := json.Marshal(ctx.Data)
	if err != nil {
		return adminMessageError(ctx, "INVALID_DATA", "Invalid request")
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return adminMessageError(ctx, "INVALID_DATA", "Invalid pagination")
	}
	if req.Page < 1 {
		req.Page = 1
	}
	if req.Limit < 1 {
		req.Limit = 50
	}
	if req.Limit > 200 {
		req.Limit = 200
	}
	if req.Page > 100000 {
		return adminMessageError(ctx, "INVALID_PAGE", "Page is too large")
	}
	var message models.Message
	if err := db.First(&message, id).Error; err != nil {
		return adminMessageDBError(ctx, err)
	}
	query := db.Table("message_recipients AS mr").Joins("JOIN users AS u ON u.id = mr.user_id").Where("mr.message_id = ?", id)
	switch req.Filter {
	case "", "all":
	case "delivered":
		query = query.Where("mr.delivered_at IS NOT NULL")
	case "read":
		query = query.Where("mr.read_at IS NOT NULL")
	case "unread":
		query = query.Where("mr.read_at IS NULL")
	case "sms_pending":
		query = query.Where("mr.sms_status IN ?", []string{models.MessageSMSPending, models.MessageSMSProcessing})
	case "sms_sent":
		query = query.Where("mr.sms_status = ?", models.MessageSMSSent)
	case "sms_failed":
		query = query.Where("mr.sms_status = ?", models.MessageSMSFailed)
	case "sms_unknown":
		query = query.Where("mr.sms_status = ?", models.MessageSMSUnknown)
	default:
		return adminMessageError(ctx, "INVALID_FILTER", "Invalid filter")
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return adminMessageDBError(ctx, err)
	}
	rows := make([]adminMessageRecipientRow, 0)
	err = query.Select("mr.*, u.login, u.billing_id").Order("mr.id ASC").Offset((req.Page - 1) * req.Limit).Limit(req.Limit).Scan(&rows).Error
	if err != nil {
		return adminMessageDBError(ctx, err)
	}
	ctx.Out["recipients"] = rows
	ctx.Out["total"] = total
	ctx.Out["page"] = req.Page
	ctx.Out["limit"] = req.Limit
	return ctx.Out
}
