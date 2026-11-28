package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"main/models"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	smsWorkers             = 2
	smsRate                = 3
	smsSendInterval        = time.Second / smsRate
	smsTimeout             = 20 * time.Second
	smsMaxAttemptsMsg      = 3
	smsRetryDelay          = 60 * time.Second
	smsMaxRetryDelay       = time.Hour
	smsPollInterval        = time.Second
	smsMaintenanceInterval = 30 * time.Second
	smsProcessingTTL       = smsTimeout + 2*time.Minute
	smsDBErrorDelay        = 5 * time.Second
	smsGatewayErrorDelay   = 30 * time.Second
	smsSaveTimeout         = 5 * time.Second
)

type smsQueueJob struct {
	ID          uint
	MessageID   uint
	UserID      uint
	SMSPhone    string
	SMSAttempts uint
	SMSText     string
	Body        string
	BodyFormat  string
}
type smsGatewayResult struct {
	Status    string
	MessageID string
	Error     string
	Retryable bool
}

var (
	smsWorkerOnce   sync.Once
	smsPhoneRegex   = regexp.MustCompile(`^375[0-9]{9}$`)
	smsPhoneCleaner = regexp.MustCompile(`[^0-9]`)
)

type smsRateLimiter struct {
	mu   sync.Mutex
	next time.Time
}

func (r *smsRateLimiter) Wait(ctx context.Context) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	if wait := time.Until(r.next); wait > 0 {
		if !smsWait(ctx, wait) {
			return ctx.Err()
		}
	}
	r.next = time.Now().Add(smsSendInterval)
	return nil
}
func smsWait(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
func startSMSWorker(ctx context.Context) {
	smsWorkerOnce.Do(func() {
		limiter := &smsRateLimiter{}
		slog(fmt.Sprintf("SMS worker started: workers=%d rate=%d/s timeout=%s max_attempts=%d", smsWorkers, smsRate, smsTimeout, smsMaxAttemptsMsg), "info")
		go smsMaintenanceLoop(ctx)
		for i := 0; i < smsWorkers; i++ {
			go smsWorkerLoop(ctx, limiter, i+1)
		}
	})
}
func smsMaintenanceLoop(ctx context.Context) {
	ticker := time.NewTicker(smsMaintenanceInterval)
	defer ticker.Stop()
	for {
		if err := smsMaintainQueue(ctx); err != nil && ctx.Err() == nil {
			slog("SMS maintenance error: "+err.Error(), "error")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
func smsMaintainQueue(ctx context.Context) error {
	now := time.Now()
	conn := db.WithContext(ctx)
	err := conn.Exec(`UPDATE message_recipients AS mr JOIN messages AS m ON m.id=mr.message_id SET mr.sms_status=?,mr.sms_next_at=NULL,mr.sms_locked_at=NULL,mr.sms_error='Message cancelled or expired',mr.updated_at=? WHERE mr.sms_status=? AND (m.status<>? OR m.send_sms=0 OR (m.expires_at IS NOT NULL AND m.expires_at<=?))`, models.MessageSMSCancelled, now, models.MessageSMSPending, models.MessageStatusPublished, now).Error
	if err != nil {
		return err
	}
	staleBefore := now.Add(-smsProcessingTTL)
	return conn.Model(&models.MessageRecipient{}).Where("sms_status = ?", models.MessageSMSProcessing).Where("sms_locked_at IS NULL OR sms_locked_at < ?", staleBefore).Updates(map[string]any{"sms_status": models.MessageSMSUnknown, "sms_locked_at": nil, "sms_next_at": nil, "sms_error": "Interrupted sending; gateway acceptance is unknown", "updated_at": now}).Error
}
func smsWorkerLoop(ctx context.Context, limiter *smsRateLimiter, workerID int) {
	for ctx.Err() == nil {
		job, err := smsFindNextJob(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			slog("SMS queue error: "+err.Error(), "error")
			if !smsWait(ctx, smsDBErrorDelay) {
				return
			}
			continue
		}
		if job == nil {
			if !smsWait(ctx, smsPollInterval) {
				return
			}
			continue
		}
		gateway, err := smsResolveGateway(getSetting("smsgate"))
		if err != nil {
			slog(fmt.Sprintf("SMS worker #%d: %s", workerID, err.Error()), "error")
			if !smsWait(ctx, smsGatewayErrorDelay) {
				return
			}
			continue
		}
		if err := limiter.Wait(ctx); err != nil {
			return
		}
		claimed, err := smsClaimJob(ctx, job)
		if err != nil {
			slog("SMS claim error: "+err.Error(), "error")
			if !smsWait(ctx, smsDBErrorDelay) {
				return
			}
			continue
		}
		if !claimed {
			continue
		}
		job.SMSAttempts++
		text := strings.TrimSpace(job.SMSText)
		if text == "" {
			if job.BodyFormat == models.MessageBodyFormatHTML {
				text = messageHTMLPlainText(job.Body)
			} else {
				text = strings.TrimSpace(job.Body)
			}
		}
		result := smsSendGateway(ctx, gateway, job.SMSPhone, text)
		saveCtx, cancel := context.WithTimeout(context.Background(), smsSaveTimeout)
		err = smsFinishJob(saveCtx, job, result)
		cancel()
		if err != nil {
			slog(fmt.Sprintf("SMS result save error: recipient=%d error=%s", job.ID, err.Error()), "error")
			continue
		}
		if result.Status == models.MessageSMSUnknown {
			slog(fmt.Sprintf("SMS result unknown: message=%d recipient=%d", job.MessageID, job.ID), "warning")
		}
	}
}
func smsResolveGateway(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("SMS gateway is not configured")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", errors.New("Invalid SMS gateway path")
	}
	info, err := os.Stat(absolute)
	if err != nil || !info.Mode().IsRegular() {
		return "", errors.New("SMS gateway script not found")
	}
	if info.Mode().Perm()&0111 == 0 {
		return "", errors.New("SMS gateway script is not executable")
	}
	return absolute, nil
}
func smsFindNextJob(ctx context.Context) (*smsQueueJob, error) {
	now := time.Now()
	var job smsQueueJob
	result := db.WithContext(ctx).Table("message_recipients AS mr").Select("mr.id,mr.message_id,mr.user_id,mr.sms_phone,mr.sms_attempts,m.sms_text,m.body,m.body_format").Joins("JOIN messages AS m ON m.id = mr.message_id").Where("mr.sms_status = ?", models.MessageSMSPending).Where("mr.sms_next_at IS NULL OR mr.sms_next_at <= ?", now).Where("m.status = ?", models.MessageStatusPublished).Where("m.send_sms = 1").Where("m.published_at <= ?", now).Where("m.expires_at IS NULL OR m.expires_at > ?", now).Order("mr.sms_next_at ASC, mr.id ASC").Limit(1).Scan(&job)
	if result.Error != nil {
		return nil, result.Error
	}
	if result.RowsAffected == 0 {
		return nil, nil
	}
	return &job, nil
}
func smsClaimJob(ctx context.Context, job *smsQueueJob) (bool, error) {
	now := time.Now()
	result := db.WithContext(ctx).Exec(`UPDATE message_recipients AS mr JOIN messages AS m ON m.id=mr.message_id SET mr.sms_status=?,mr.sms_attempts=mr.sms_attempts+1,mr.sms_locked_at=?,mr.updated_at=? WHERE mr.id=? AND mr.sms_status=? AND mr.sms_attempts=? AND (mr.sms_next_at IS NULL OR mr.sms_next_at<=?) AND m.status=? AND m.send_sms=1 AND m.published_at<=? AND (m.expires_at IS NULL OR m.expires_at>?)`, models.MessageSMSProcessing, now, now, job.ID, models.MessageSMSPending, job.SMSAttempts, now, models.MessageStatusPublished, now, now)
	if result.Error != nil {
		return false, result.Error
	}
	return result.RowsAffected == 1, nil
}
func smsSendGateway(ctx context.Context, gateway, phone, text string) smsGatewayResult {
	phone = smsPhoneCleaner.ReplaceAllString(phone, "")
	if !smsPhoneRegex.MatchString(phone) {
		return smsGatewayResult{Status: models.MessageSMSFailed, Error: "Invalid phone number"}
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return smsGatewayResult{Status: models.MessageSMSFailed, Error: "SMS text is empty"}
	}
	if utf8.RuneCountInString(text) > 1000 {
		return smsGatewayResult{Status: models.MessageSMSFailed, Error: "SMS text exceeds 1000 characters"}
	}
	execCtx, cancel := context.WithTimeout(ctx, smsTimeout)
	defer cancel()
	cmd := exec.CommandContext(execCtx, gateway, phone, text)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return smsGatewayResult{Status: models.MessageSMSFailed, Error: "Could not start SMS gateway", Retryable: true}
	}
	runErr := cmd.Wait()
	messageID, rejected := smsParseGatewayResponse(stdout.Bytes())
	if runErr == nil && messageID != "" && !rejected {
		return smsGatewayResult{Status: models.MessageSMSSent, MessageID: messageID}
	}
	if execCtx.Err() != nil {
		return smsGatewayResult{Status: models.MessageSMSUnknown, Error: "SMS gateway timeout or interrupted request"}
	}
	if rejected {
		return smsGatewayResult{Status: models.MessageSMSFailed, Error: "SMS gateway rejected the message"}
	}
	if runErr != nil {
		return smsGatewayResult{Status: models.MessageSMSUnknown, Error: "SMS gateway execution failed; acceptance is unknown"}
	}
	return smsGatewayResult{Status: models.MessageSMSUnknown, Error: "SMS gateway returned no valid message_id"}
}
func smsParseGatewayResponse(raw []byte) (messageID string, rejected bool) {
	var response map[string]json.RawMessage
	if err := json.Unmarshal(raw, &response); err != nil || response == nil {
		return "", false
	}
	for _, key := range []string{"error_code", "error_text"} {
		value, exists := response[key]
		if exists && string(bytes.TrimSpace(value)) != "null" {
			return "", true
		}
	}
	value, exists := response["message_id"]
	if !exists || string(bytes.TrimSpace(value)) == "null" {
		return "", false
	}
	var stringID string
	if err := json.Unmarshal(value, &stringID); err == nil {
		stringID = strings.TrimSpace(stringID)
		if len(stringID) > 0 && len(stringID) <= 128 {
			return stringID, false
		}
		return "", false
	}
	var numericID json.Number
	if err := json.Unmarshal(value, &numericID); err == nil {
		id := numericID.String()
		if len(id) > 0 && len(id) <= 128 {
			return id, false
		}
	}
	return "", false
}
func smsGetRetryDelay(attempt uint) time.Duration {
	delay := smsRetryDelay
	for i := uint(1); i < attempt; i++ {
		delay *= 2
		if delay >= smsMaxRetryDelay {
			return smsMaxRetryDelay
		}
	}
	return delay
}
func smsFinishJob(ctx context.Context, job *smsQueueJob, result smsGatewayResult) error {
	now := time.Now()
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		status := result.Status
		var nextAt, sentAt *time.Time
		if result.Retryable && job.SMSAttempts < smsMaxAttemptsMsg {
			var message models.Message
			err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&message, job.MessageID).Error
			if err != nil {
				return err
			}
			active := message.Status == models.MessageStatusPublished && message.SendSMS && (message.ExpiresAt == nil || message.ExpiresAt.After(now))
			if active {
				status = models.MessageSMSPending
				next := now.Add(smsGetRetryDelay(job.SMSAttempts))
				nextAt = &next
			} else {
				status = models.MessageSMSCancelled
			}
		}
		if status == models.MessageSMSSent {
			sentAt = &now
		}
		update := tx.Model(&models.MessageRecipient{}).Where("id = ?", job.ID).Where("sms_status = ?", models.MessageSMSProcessing).Where("sms_attempts = ?", job.SMSAttempts).Updates(map[string]any{"sms_status": status, "sms_message_id": result.MessageID, "sms_sent_at": sentAt, "sms_next_at": nextAt, "sms_locked_at": nil, "sms_error": result.Error, "updated_at": now})
		if update.Error != nil {
			return update.Error
		}
		if update.RowsAffected != 1 {
			return errors.New("SMS job state changed before result was saved")
		}
		return nil
	})
}
