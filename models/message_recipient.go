package models

import "time"

const (
	MessageSMSDisabled   = "disabled"
	MessageSMSPending    = "pending"
	MessageSMSProcessing = "processing"
	MessageSMSSent       = "sent"
	MessageSMSFailed     = "failed"
	MessageSMSCancelled  = "cancelled"
	MessageSMSUnknown    = "unknown"
)

type MessageRecipient struct {
	ID uint `gorm:"primaryKey" json:"id"`

	// ID сообщения.
	MessageID uint `gorm:"not null;uniqueIndex:ux_message_recipient,priority:1" json:"message_id"`

	// ID абонента.
	UserID uint `gorm:"not null;uniqueIndex:ux_message_recipient,priority:2;index:idx_user_unread,priority:1" json:"user_id"`

	// Время подтверждённого получения сообщения.
	DeliveredAt *time.Time `json:"delivered_at"`

	// Время прочтения сообщения.
	ReadAt *time.Time `gorm:"index:idx_user_unread,priority:2" json:"read_at"`

	// Номер телефона на момент публикации.
	SMSPhone string `gorm:"size:16" json:"sms_phone"`

	// Состояние отправки SMS.
	SMSStatus string `gorm:"size:16;not null;default:'disabled';index:idx_sms_queue,priority:1" json:"sms_status"`

	// Количество попыток отправки.
	SMSAttempts uint `gorm:"not null;default:0" json:"sms_attempts"`

	// Время успешной передачи SMS шлюзу.
	SMSSentAt *time.Time `json:"sms_sent_at"`

	// Идентификатор сообщения в SMS-шлюзе.
	SMSMessageID string `gorm:"size:128" json:"sms_message_id"`

	// Время следующей попытки отправки.
	SMSNextAt *time.Time `gorm:"index:idx_sms_queue,priority:2" json:"sms_next_at"`

	// Время захвата задачи SMS-воркером.
	SMSLockedAt *time.Time `json:"-"`

	// Последняя ошибка SMS-шлюза.
	SMSError string `gorm:"type:text" json:"sms_error"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	Message Message `gorm:"foreignKey:MessageID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE;" json:"-"`

	User User `gorm:"foreignKey:UserID;constraint:OnUpdate:CASCADE,OnDelete:CASCADE;" json:"-"`
}
