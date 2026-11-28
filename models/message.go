package models

import "time"

const (
	MessageAudienceAll        = "all"
	MessageAudienceIndividual = "individual"
)

const (
	MessagePriorityNormal    = "normal"
	MessagePriorityImportant = "important"
	MessagePriorityCritical  = "critical"
)

const (
	MessageStatusDraft     = "draft"
	MessageStatusScheduled = "scheduled"
	MessageStatusPublished = "published"
	MessageStatusCancelled = "cancelled"
)

const (
	MessageBodyFormatText = "text"
	MessageBodyFormatHTML = "html"
)

type Message struct {
	ID uint `gorm:"primaryKey" json:"id"`

	// Заголовок сообщения.
	Title string `gorm:"size:255;not null" json:"title"`

	// Основной текст сообщения.
	Body string `gorm:"type:text;not null" json:"body"`

	BodyFormat string `gorm:"size:8;not null;default:text" json:"body_format"`

	// all — массовая рассылка.
	// individual — выбранные абоненты.
	Audience string `gorm:"size:16;not null;default:'individual'" json:"audience"`

	// normal, important, critical.
	Priority string `gorm:"size:16;not null;default:'normal'" json:"priority"`

	// draft, scheduled, published, cancelled.
	Status string `gorm:"size:16;not null;default:'draft';index:idx_message_schedule,priority:1" json:"status"`

	// Дублирование сообщения через SMS.
	SendSMS bool `gorm:"not null;default:false" json:"send_sms"`

	// Отдельный сокращённый текст SMS.
	// Если пустой — используется Body.
	SMSText string `gorm:"type:text" json:"sms_text"`

	// ID оператора, создавшего сообщение.
	CreatedBy uint `gorm:"not null;index" json:"created_by"`

	// Запланированное время публикации.
	ScheduledAt *time.Time `gorm:"index:idx_message_schedule,priority:2" json:"scheduled_at"`

	// Фактическое время публикации.
	PublishedAt *time.Time `json:"published_at"`

	// Срок действия сообщения.
	ExpiresAt *time.Time `gorm:"index" json:"expires_at"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}
